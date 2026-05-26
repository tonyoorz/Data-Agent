import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AIChat from "@/components/dashboard/pages/AIChat";

describe("AIChat duplicate search integration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows duplicate search mode controls and defaults to deepseek v4 pro", () => {
    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    expect(
      screen.getByRole("button", { name: /duplicate search/i }),
    ).toBeInTheDocument();

    expect(screen.getByRole("combobox")).toHaveValue("deepseek-v4-pro");
    expect(screen.getByRole("switch", { name: /缺陷上下文/i })).not.toBeChecked();
  });

  it("requests duplicate-search warmup when switching to duplicate-search mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "warm" }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/duplicate-search/warmup",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });

  it("submits duplicate search queries to the local API and renders candidates", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          searchId: "search-1",
          queryText: "IDCEVO 26/07 导航黑屏",
          modelPhase: "click_boost",
          feedbackCount: 3,
          summaryText: "最可能的重复问题是 DTV-1024，请优先复核。",
          answerModel: "deepseek-v4-pro",
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
        },
      }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "IDCEVO 26/07 导航黑屏" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/duplicate-search",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    expect(await screen.findByText("DTV-1024")).toBeInTheDocument();
    expect(screen.getByText("最可能的重复问题是 DTV-1024，请优先复核。")).toBeInTheDocument();
  });

  it("submits standard AI chat requests to the dedicated AI endpoint", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"type":"context","context":"# Defect context from qgate","result":{"searchId":"ctx-1","queryText":"请总结当前缺陷风险","modelPhase":"click_boost","feedbackCount":0,"candidates":[{"ticketId":"2686999","name":"导航黄屏 related defect","score1to10":8,"similarity":0.88,"project":"IDCEVO","pu":"26-07","statusPhase":"03-In Analysis_Medium","snippet":"与导航黑屏和黄屏相关的历史缺陷。"}]}}\n\n' +
                  'data: {"choices":[{"delta":{"content":"<think>分析中</think>"}}]}\n\n' +
                  'data: {"choices":[{"delta":{"content":"**Signal** 已完成"}}]}\n\n' +
                  'data: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        json: async () => ({ error: "unexpected" }),
      });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/chat",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).useDefectContext,
    ).toBe(false);

    expect(await screen.findByText("2686999")).toBeInTheDocument();
    expect(screen.getByText("导航黄屏 related defect")).toBeInTheDocument();
  });

  it("shows an immediate generating status for pure AI chat before the first visible answer chunk", async () => {
    const encoder = new TextEncoder();
    let resolveChatResponse: ((value: unknown) => void) | null = null;

    const chatResponse = new Promise((resolve) => {
      resolveChatResponse = resolve;
    });

    const fetchMock = vi.fn().mockImplementation(() => chatResponse as Promise<Response>);

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "agent 如何创建" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("正在生成回答…")).toBeInTheDocument();

    resolveChatResponse?.({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"reasoning_content":"先思考一下"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"已完成"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      json: async () => ({ error: "unexpected" }),
    });

    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });

  it("includes defect context for AI chat only after the toggle is enabled", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"status","message":"正在检索 qgate 相关缺陷…"}\n\n' +
                'data: {"type":"context","context":"# Defect context from qgate","result":{"searchId":"ctx-1","queryText":"请总结当前缺陷风险","modelPhase":"click_boost","feedbackCount":0,"candidates":[{"ticketId":"2686999","name":"导航黄屏 related defect","score1to10":8,"similarity":0.88,"project":"IDCEVO","pu":"26-07","statusPhase":"03-In Analysis_Medium","snippet":"与导航黑屏和黄屏相关的历史缺陷。"}]}}\n\n' +
                'data: {"choices":[{"delta":{"content":"已完成"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      json: async () => ({ error: "unexpected" }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("switch", { name: /缺陷上下文/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/chat",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).useDefectContext,
    ).toBe(true);
    expect(await screen.findByText("正在检索 qgate 相关缺陷…")).toBeInTheDocument();
    expect(screen.getByText("2686999")).toBeInTheDocument();
  });

  it("shows retrieved defect context before the first AI chunk arrives", async () => {
    const encoder = new TextEncoder();
    let resolveChatResponse: ((value: unknown) => void) | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const chatResponse = new Promise((resolve) => {
      resolveChatResponse = resolve;
    });

    const fetchMock = vi
      .fn()
      .mockImplementation(() => chatResponse as Promise<Response>);

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("switch", { name: /缺陷上下文/i }));

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/chat",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    resolveChatResponse?.({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            encoder.encode(
              'data: {"type":"context","context":"# Defect context from qgate","result":{"searchId":"ctx-2","queryText":"请总结当前缺陷风险","modelPhase":"click_boost","feedbackCount":0,"candidates":[{"ticketId":"2686999","name":"导航黄屏 related defect","score1to10":8,"similarity":0.88,"project":"IDCEVO","pu":"26-07","statusPhase":"03-In Analysis_Medium","snippet":"与导航黑屏和黄屏相关的历史缺陷。"}]}}\n\n',
            ),
          );
        },
      }),
      json: async () => ({ error: "unexpected" }),
    });

    expect(await screen.findByText("2686999")).toBeInTheDocument();
    expect(screen.getByText("导航黄屏 related defect")).toBeInTheDocument();
    expect(screen.getByText("已获取 qgate 相关缺陷，正在生成回答…")).toBeInTheDocument();

    streamController?.enqueue(
      encoder.encode(
        'data: {"choices":[{"delta":{"content":"**Signal** 已完成"}}]}\n\n' +
          'data: [DONE]\n\n',
      ),
    );
    streamController?.close();

    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });

  it("shows an immediate retrieval status before context arrives", async () => {
    const encoder = new TextEncoder();
    let resolveChatResponse: ((value: unknown) => void) | null = null;

    const chatResponse = new Promise((resolve) => {
      resolveChatResponse = resolve;
    });

    const fetchMock = vi.fn().mockImplementation(() => chatResponse as Promise<Response>);

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("switch", { name: /缺陷上下文/i }));

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "speech can not wakeup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/chat",
        expect.objectContaining({ method: "POST" }),
      );
    });

    resolveChatResponse?.({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"status","message":"正在检索 qgate 相关缺陷…"}\n\n',
            ),
          );
        },
      }),
      json: async () => ({ error: "unexpected" }),
    });

    expect(await screen.findByText("正在检索 qgate 相关缺陷…")).toBeInTheDocument();
  });
});