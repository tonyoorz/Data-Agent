import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expandImageMessagesWithOcr, recognizeImageText } from "../../../server/imageOcr.mjs";

describe("recognizeImageText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUPSEARCH_OCR_PROVIDER;
    delete process.env.DUPSEARCH_OCR_URL;
    delete process.env.DUPSEARCH_OCR_API_KEY;
    delete process.env.DUPSEARCH_OCR_AUTH_SCHEME;
    delete process.env.DUPSEARCH_OCR_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses local RapidOCR by default when no remote OCR provider is configured", async () => {
    const localRapidOcrRunner = vi.fn().mockResolvedValue({ text: "  local image text  " });

    await expect(
      recognizeImageText(
        { imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
        process.env,
        { localRapidOcrRunner },
      ),
    ).resolves.toEqual({ text: "local image text" });

    expect(localRapidOcrRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        imageBase64: "iVBORw0KGgo=",
        mimeType: "image/png",
        config: expect.objectContaining({
          provider: "local-rapidocr",
        }),
      }),
    );
  });

  it("does not let a stale OCR URL implicitly opt images into a remote provider", async () => {
    const localRapidOcrRunner = vi.fn().mockResolvedValue({ text: "local only" });
    const fetchImpl = vi.fn();

    await expect(recognizeImageText(
      { imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      {
        DUPSEARCH_OCR_URL: "https://example.test/ocr",
        DUPSEARCH_OCR_API_KEY: "stale-key",
      },
      { localRapidOcrRunner, fetchImpl },
    )).resolves.toEqual({ text: "local only" });
    expect(localRapidOcrRunner).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when the remote OCR provider is selected without a URL", async () => {
    process.env.DUPSEARCH_OCR_PROVIDER = "remote";

    await expect(
      recognizeImageText({ imageUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    ).rejects.toMatchObject({ code: "IMAGE_OCR_URL_REQUIRED" });
  });

  it.each(["/etc/passwd", "../private.png", "file:///tmp/private.png", "https://example.test/image.png"])(
    "rejects non-data image input before a local worker can read %s",
    async (imageUrl) => {
      const localRapidOcrRunner = vi.fn();

      await expect(
        recognizeImageText({ imageUrl }, process.env, { localRapidOcrRunner }),
      ).rejects.toMatchObject({ code: "IMAGE_OCR_INPUT_INVALID" });
      expect(localRapidOcrRunner).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://ocr.example.test/v1",
    "https://user@ocr.example.test/v1",
    "https://ocr.example.test/v1?token=secret",
    "https://ocr.example.test/v1#fragment",
  ])("rejects an unsafe remote OCR URL %s", async (url) => {
    await expect(recognizeImageText(
      { imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      {
        DUPSEARCH_OCR_PROVIDER: "remote",
        DUPSEARCH_OCR_URL: url,
        DUPSEARCH_OCR_API_KEY: "ocr-key",
      },
    )).rejects.toMatchObject({ code: "IMAGE_OCR_URL_INVALID" });
  });

  it("posts data URL images to the configured OCR provider and returns trimmed text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "  detected image text  " }),
      text: async () => "",
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
    });

    await expect(
      recognizeImageText(
        { imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
        {
          DUPSEARCH_OCR_PROVIDER: "remote",
          DUPSEARCH_OCR_URL: "https://example.test/ocr",
          DUPSEARCH_OCR_API_KEY: "ocr-key",
        },
        {
          fetchImpl: fetchMock,
          timeoutSignal: () => ({ kind: "ocr-timeout" }),
        },
      ),
    ).resolves.toEqual({ text: "detected image text" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/ocr",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ocr-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          image: "iVBORw0KGgo=",
          mime: "image/png",
        }),
        redirect: "error",
        signal: { kind: "ocr-timeout" },
      }),
    );
  });

  it("requires a dedicated API key before sending an image to a remote OCR provider", async () => {
    const fetchImpl = vi.fn();

    await expect(recognizeImageText(
      { imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      {
        DUPSEARCH_OCR_PROVIDER: "remote",
        DUPSEARCH_OCR_URL: "https://example.test/ocr",
      },
      { fetchImpl },
    )).rejects.toMatchObject({ code: "IMAGE_OCR_API_KEY_REQUIRED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps remote failures without reading or exposing an upstream body", async () => {
    const text = vi.fn(async () => "private provider details");
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, body: { cancel }, text }));

    await expect(recognizeImageText(
      { imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      {
        DUPSEARCH_OCR_PROVIDER: "remote",
        DUPSEARCH_OCR_URL: "https://example.test/ocr",
        DUPSEARCH_OCR_API_KEY: "ocr-key",
      },
      { fetchImpl, timeoutSignal: () => ({ aborted: false }) },
    )).rejects.toMatchObject({ code: "IMAGE_OCR_UPSTREAM_HTTP_ERROR" });
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds remote OCR requests and maps timeouts to a stable code", async () => {
    const signal = { aborted: true };
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("private timeout"), { name: "AbortError" });
    });

    await expect(recognizeImageText(
      { imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      {
        DUPSEARCH_OCR_PROVIDER: "remote",
        DUPSEARCH_OCR_URL: "https://example.test/ocr",
        DUPSEARCH_OCR_API_KEY: "ocr-key",
        DUPSEARCH_OCR_TIMEOUT_MS: "2500",
      },
      { fetchImpl, timeoutSignal: (timeoutMs) => ({ ...signal, timeoutMs }) },
    )).rejects.toMatchObject({ code: "IMAGE_OCR_UPSTREAM_TIMEOUT" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/ocr",
      expect.objectContaining({
        redirect: "error",
        signal: { ...signal, timeoutMs: 2500 },
      }),
    );
  });
});

describe("expandImageMessagesWithOcr", () => {
  const imagePart = () => ({
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
  });

  it("rejects attachment fanout before starting OCR workers", async () => {
    const imageOcrRunner = vi.fn().mockResolvedValue({ text: "text" });
    const messages = Array.from({ length: 9 }, () => ({
      role: "user",
      content: [imagePart()],
    }));

    await expect(expandImageMessagesWithOcr(messages, {}, { imageOcrRunner }))
      .rejects.toMatchObject({ code: "CHAT_ATTACHMENT_LIMIT_EXCEEDED" });
    expect(imageOcrRunner).not.toHaveBeenCalled();
  });

  it("bounds concurrent OCR workers across messages", async () => {
    let active = 0;
    let maximumActive = 0;
    const imageOcrRunner = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { text: "text" };
    });
    const messages = Array.from({ length: 6 }, () => ({
      role: "user",
      content: [imagePart()],
    }));

    await expandImageMessagesWithOcr(messages, {}, { imageOcrRunner, maxConcurrency: 2 });
    expect(imageOcrRunner).toHaveBeenCalledTimes(6);
    expect(maximumActive).toBeLessThanOrEqual(2);
  });

  it("rejects aggregate decoded bytes before starting OCR", async () => {
    const imageOcrRunner = vi.fn();
    await expect(expandImageMessagesWithOcr(
      [{ role: "user", content: [imagePart()] }],
      {},
      {
        imageOcrRunner,
        attachmentLimits: {
          maxAttachments: 8,
          maxAttachmentBytes: 7,
          maxTotalBytes: 7,
        },
      },
    )).rejects.toMatchObject({ code: "CHAT_ATTACHMENT_BYTES_EXCEEDED" });
    expect(imageOcrRunner).not.toHaveBeenCalled();
  });
});
