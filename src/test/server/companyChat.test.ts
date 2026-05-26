import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamCompanyChatCompletion } from "../../../server/companyChat.mjs";

describe("streamCompanyChatCompletion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.DUPSEARCH_CHAT_ACCESS_CODE = "test-access-code";
  });

  it("forwards upstream SSE chunks without waiting for response.json", async () => {
    const encoder = new TextEncoder();
    const write = vi.fn();
    const end = vi.fn();
    const writeHead = vi.fn();
    const response = {
      writeHead,
      write,
      end,
    };

    const json = vi.fn(async () => {
      throw new Error("json should not be called for streaming responses");
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      json,
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);
    const onMetrics = vi.fn();

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "hello" }],
      model: "deepseek-v4-pro",
      context: "ctx",
      response,
      onMetrics,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"stream":true'),
      }),
    );
    expect(json).not.toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/event-stream; charset=utf-8",
      }),
    );
    const streamedText = write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");
    expect(streamedText).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}');
    expect(streamedText).toContain("data: [DONE]");
    expect(end).toHaveBeenCalled();
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkCount: 1,
        byteCount: expect.any(Number),
        upstreamConnectMs: expect.any(Number),
        firstChunkMs: expect.any(Number),
        streamTotalMs: expect.any(Number),
      }),
    );
  });
});