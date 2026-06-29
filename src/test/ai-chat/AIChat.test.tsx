import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AIChat from "@/components/dashboard/pages/AIChat";

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

  it("shows duplicate search mode controls and defaults to deepseek v4 flash", () => {
    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    expect(
      screen.getByRole("button", { name: /duplicate search/i }),
    ).toBeInTheDocument();

    expect(screen.getByRole("combobox")).toHaveValue("deepseek-v4-flash");
    expect(screen.getByRole("switch", { name: /缺陷上下文/i })).not.toBeChecked();
  });

  it("does not request duplicate-search warmup when switching to duplicate-search mode", async () => {
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    render(<AIChat moduleKey="ai-chat" moduleLabel="AI Chat" />);

    fireEvent.click(screen.getByRole("button", { name: /duplicate search/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^duplicate search$/i, pressed: true }),
      ).toBeInTheDocument();
    });

    expect(fetchMock).not.toHaveBeenCalled();
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

  it("transcribes recorded audio and fills the input without auto-sending", async () => {
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