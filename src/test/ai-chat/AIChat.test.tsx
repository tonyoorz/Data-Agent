import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());
const onAuthStateChangeMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
      onAuthStateChange: onAuthStateChangeMock,
    },
  },
}));

import AIChat from "@/components/dashboard/pages/AIChat";
import { actorScopedChatStorageKey } from "@/components/dashboard/chat/chatStorage";

let authStateChangeCallback: ((event: string, session: unknown) => void) | null = null;

class MockMediaRecorder {
  public static instances: MockMediaRecorder[] = [];

  public state: "inactive" | "recording" = "inactive";
  public ondataavailable: ((event: { data: Blob }) => void) | null = null;
  public onstop: (() => void) | null = null;

  constructor(_stream: MediaStream) {
    MockMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["voice-bytes"], { type: "audio/webm" }),
    });
    this.onstop?.();
  }
}

describe("AIChat duplicate search integration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null });
    authStateChangeCallback = null;
    onAuthStateChangeMock.mockReset();
    onAuthStateChangeMock.mockImplementation((callback) => {
      authStateChangeCallback = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    MockMediaRecorder.instances = [];

    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: MockMediaRecorder,
    });

    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "audioinput", deviceId: "default", label: "Default Microphone" },
          { kind: "audioinput", deviceId: "headset-mic", label: "Headset Microphone" },
        ]),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders even when crypto.randomUUID is unavailable", () => {
    const originalCrypto = globalThis.crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        ...originalCrypto,
        randomUUID: undefined,
      },
    });

    try {
      render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

      expect(screen.getByRole("button", { name: /ai chat/i })).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it("partitions persisted conversations by an opaque authenticated-actor namespace", async () => {
    const actorA = { user: { id: "user-a@example.test" }, access_token: "token-a" };
    const actorB = { user: { id: "user-b@example.test" }, access_token: "token-b" };
    const actorAKey = await actorScopedChatStorageKey(actorA);
    const actorBKey = await actorScopedChatStorageKey(actorB);
    expect(actorAKey).toMatch(/^dtsv\.chat\.v3\.[a-f0-9]{64}$/);
    expect(actorBKey).toMatch(/^dtsv\.chat\.v3\.[a-f0-9]{64}$/);
    expect(actorAKey).not.toContain("user-a");
    expect(actorBKey).not.toContain("user-b");
    expect(actorAKey).not.toBe(actorBKey);

    window.localStorage.setItem("dtsv.chat.v2", JSON.stringify([{
      id: "legacy",
      title: "Legacy cross-user secret",
      messages: [],
      updatedAt: 1,
    }]));
    window.localStorage.setItem(actorAKey!, JSON.stringify([{
      id: "actor-a-thread",
      title: "Actor A private chat",
      messages: [{ id: "a-message", role: "assistant", content: "Actor A secret" }],
      updatedAt: 2,
    }]));
    window.localStorage.setItem(actorBKey!, JSON.stringify([{
      id: "actor-b-thread",
      title: "Actor B private chat",
      messages: [{ id: "b-message", role: "assistant", content: "Actor B secret" }],
      updatedAt: 3,
    }]));
    getSessionMock.mockResolvedValue({ data: { session: actorA }, error: null });

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);
    expect(await screen.findByText("Actor A secret")).toBeInTheDocument();
    expect(screen.queryByText("Actor B secret")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy cross-user secret")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("dtsv.chat.v2")).toBeNull();

    act(() => {
      authStateChangeCallback?.("SIGNED_IN", actorB);
    });

    expect(screen.queryByText("Actor A secret")).not.toBeInTheDocument();
    expect(screen.queryByText("Actor B secret")).not.toBeInTheDocument();
    expect(await screen.findByText("Actor B secret")).toBeInTheDocument();
    expect(screen.queryByText("Actor A secret")).not.toBeInTheDocument();
  });

  it("shows duplicate search mode controls and defaults to deepseek v4 flash", () => {
    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    expect(
      screen.getByRole("button", { name: /duplicate search/i }),
    ).toBeInTheDocument();

    expect(screen.getByRole("combobox")).toHaveValue("deepseek-v4-pro");
    expect(screen.getByRole("switch", { name: /缺陷上下文/i })).not.toBeChecked();
  });

  it("offers the supported GLMProxy chat models", () => {
    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    expect(screen.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "qwen3.7-max",
      "qwen3.7-flash",
      "glm-5.1",
    ]);
  });

  it("keeps the defect context control inside the composer context chip", () => {
    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    const contextChip = screen.getByRole("group", { name: "输入上下文" });

    expect(within(contextChip).getByText("上下文：")).toBeInTheDocument();
    expect(within(contextChip).getByText("AI Chat")).toBeInTheDocument();
    expect(within(contextChip).getByRole("switch", { name: /缺陷上下文/i })).not.toBeChecked();
  });

  it("requests duplicate-search warmup in the background when switching to duplicate-search mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^duplicate search$/i, pressed: true }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/duplicate-search/warmup",
        expect.objectContaining({ method: "POST" }),
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
          answerModel: "deepseek-v4-flash",
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

  it("uses a concise local duplicate fallback summary when the API omits summary text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          searchId: "search-compact-fallback-1",
          queryText: "speech can not wakeup",
          modelPhase: "click_boost",
          feedbackCount: 7,
          candidates: [
            {
              ticketId: "2754092",
              name: "Speech can not be wake up",
              score1to10: 6,
              confidenceScore1to10: 7,
              similarity: 0.56,
              snippet: "Speech cannot be woken up after software update on U12 BEV.",
              evidenceSnippets: ["Defect name: Speech cannot be woken up after software update on U12 BEV."],
            },
          ],
        },
      }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "speech can not wakeup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText(/优先复核: D2754092/)).toBeInTheDocument();
    const text = document.body.textContent || "";
    expect(text).not.toContain("现象匹配:");
    expect(text).not.toContain("候选概览:");
  });

  it("shows an immediate retrieval status for duplicate search before results arrive", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      return new Promise(() => {}) as Promise<Response>;
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "IDCEVO 26/07 导航黑屏" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("正在检索历史重复问题…")).toBeInTheDocument();
  });

  it("reveals duplicate-search summary before rendering the candidate list", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          result: {
            searchId: "search-2",
            queryText: "IDCEVO 26/07 导航黑屏",
            modelPhase: "click_boost",
            feedbackCount: 3,
            summaryText: "最可能的重复问题是 DTV-1024，请优先复核。",
            answerModel: "deepseek-v4-flash",
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
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "IDCEVO 26/07 导航黑屏" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/duplicate-search",
      expect.objectContaining({
        method: "POST",
      }),
    );

    expect(screen.queryByText("DTV-1024")).not.toBeInTheDocument();

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });

    expect(screen.getByText("最可能的重复问题是 DTV-1024，请优先复核。")).toBeInTheDocument();
    expect(screen.getByText("DTV-1024")).toBeInTheDocument();
  });

  it("keeps the replacement duplicate-search request active after stopping the previous one", async () => {
    let releaseFirstAbort: (() => void) | null = null;

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as { query?: string };

      if (requestBody.query === "first search") {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            releaseFirstAbort = () => reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }

      return new Promise(() => {}) as Promise<Response>;
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "first search" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("button", { name: "停止生成" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "second search" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument();

    releaseFirstAbort?.();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
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

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.useDefectContext).toBe(false);
    expect(requestBody.useAnalyticsContext).toBe(true);
    expect(requestBody.threadId).toEqual(expect.any(String));
    expect(requestBody.threadId).not.toBe("");

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("2686999")).not.toBeInTheDocument();
    expect(screen.queryByText("导航黄屏 related defect")).not.toBeInTheDocument();
  });

  it("forwards the current Supabase access token only in the standard AI chat authorization header", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "session-token" } },
      error: null,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      body: null,
      json: async () => ({ error: "Unauthorized" }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/chat",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const requestOptions = fetchMock.mock.calls.find(([url]) => url === "/api/ai/chat")?.[1];
    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(requestOptions?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer session-token",
    });
    expect(String(requestOptions?.body)).not.toContain("session-token");
  });

  it.each([
    ["no session is available", () => getSessionMock.mockResolvedValue({ data: { session: null }, error: null })],
    ["the session access token is blank", () => getSessionMock.mockResolvedValue({ data: { session: { access_token: "" } }, error: null })],
    ["the session lookup reports an error", () => getSessionMock.mockResolvedValue({ data: { session: null }, error: new Error("session lookup failed") })],
    ["the session lookup throws", () => getSessionMock.mockRejectedValue(new Error("session lookup failed"))],
  ])("omits the authorization header when %s", async (_description, configureSession) => {
    configureSession();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      body: null,
      json: async () => ({ error: "Unauthorized" }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/chat",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const requestOptions = fetchMock.mock.calls.find(([url]) => url === "/api/ai/chat")?.[1];
    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(requestOptions?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("shows the company token price for a versioned DeepSeek V4 Pro response", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"已完成"}}]}' +
                '\n\n' +
                'data: {"model":"deepseek-v4-pro-260425","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}' +
                '\n\n' +
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

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "deepseek-v4-pro" } });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(await screen.findByLabelText("模型 deepseek-v4-pro-260425")).toBeInTheDocument();
    expect(screen.getByText("Tokens 1,500")).toBeInTheDocument();
    expect(screen.getByText("Cost ¥0.024")).toBeInTheDocument();
  });

  it("uses the company zero price for Qwen 3.7 Max", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"已完成"}}]}' +
                '\n\n' +
                'data: {"model":"qwen3.7-max-2026-06-08","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}' +
                '\n\n' +
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

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "qwen3.7-max" } });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(await screen.findByLabelText("模型 qwen3.7-max-2026-06-08")).toBeInTheDocument();
    expect(screen.getByText("Cost ¥0")).toBeInTheDocument();
  });

  it("does not estimate token cost for a model billed by route", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"已完成"}}]}' +
                '\n\n' +
                'data: {"model":"glm-5-2-260617","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}' +
                '\n\n' +
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

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "glm-5.1" } });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "请总结当前缺陷风险" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(await screen.findByLabelText("模型 glm-5-2-260617")).toBeInTheDocument();
    expect(screen.getByText("Tokens 1,500")).toBeInTheDocument();
    expect(screen.queryByText(/^Cost /)).not.toBeInTheDocument();
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

  it("renders structured tool events as real analysis steps", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"tool-input-available","toolCallId":"call-1","toolName":"query_dashboard_summary","input":{"filters":{"years":2026}}}\n\n' +
                'data: {"type":"tool-output-available","toolCallId":"call-1","toolName":"query_dashboard_summary","outputSummary":"Result: 12 defects"}\n\n' +
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
      target: { value: "DTSV 6月份提了多少bug？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("调用工具")).toBeInTheDocument();
    expect(await screen.findByText("工具返回")).toBeInTheDocument();
    await screen.findByText("Result: 12 defects");
    expect(screen.getAllByText("query_dashboard_summary")).toHaveLength(2);
    expect(await screen.findByText("Result: 12 defects")).toBeInTheDocument();
    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });

  it("sends uploaded PDF attachments to the AI chat gateway", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      json: async () => ({ error: "unexpected" }),
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const pdf = new File(["%PDF-1.4 invoice text"], "invoice.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [pdf] } });

    await screen.findByText("invoice.pdf");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "PDF 里说了什么" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/chat",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const userMessage = payload.messages.find((message: { role: string }) => message.role === "user");
    expect(userMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "PDF 里说了什么" }),
        expect.objectContaining({
          type: "file_data",
          file_data: expect.objectContaining({
            name: "invoice.pdf",
            mime_type: "application/pdf",
            url: expect.stringMatching(/^data:application\/pdf;base64,/),
          }),
        }),
      ]),
    );
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
    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("2686999")).not.toBeInTheDocument();
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

    expect(await screen.findByText("已获取 qgate 相关缺陷，正在生成回答…")).toBeInTheDocument();
    expect(screen.queryByText("2686999")).not.toBeInTheDocument();
    expect(screen.queryByText("导航黄屏 related defect")).not.toBeInTheDocument();

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

  it("transcribes recorded audio and fills the input without auto-sending", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "voice-session-token" } },
      error: null,
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/ai/transcribe") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, text: "voice transcript" }),
          text: async () => "",
        });
      }

      return Promise.resolve({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        json: async () => ({ error: "unexpected" }),
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));
    fireEvent.click(await screen.findByRole("button", { name: "停止录音" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/transcribe",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer voice-session-token",
          },
        }),
      );
    });

    expect(screen.getByRole("textbox")).toHaveValue("voice transcript");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("automatically records from a headset microphone when one is available", async () => {
    const getUserMediaMock = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, text: "voice transcript" }),
      text: async () => "",
    });

    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: getUserMediaMock,
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "audioinput", deviceId: "default", label: "Default Microphone" },
          { kind: "audioinput", deviceId: "headset-mic", label: "Headset Microphone" },
        ]),
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    await waitFor(() => {
      expect(screen.queryByLabelText("麦克风")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));

    await waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalledWith({
        audio: { deviceId: { exact: "headset-mic" } },
      });
    });
  });

  it("shows the backend transcription error when transcription fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "ASR service is unavailable" }),
      text: async () => "ASR service is unavailable",
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));
    fireEvent.click(await screen.findByRole("button", { name: "停止录音" }));

    expect(await screen.findByText("ASR service is unavailable")).toBeInTheDocument();
  });
});
