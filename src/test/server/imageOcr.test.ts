import { beforeEach, describe, expect, it, vi } from "vitest";

import { recognizeImageText } from "../../../server/imageOcr.mjs";

describe("recognizeImageText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUPSEARCH_OCR_PROVIDER;
    delete process.env.DUPSEARCH_OCR_URL;
    delete process.env.DUPSEARCH_OCR_API_KEY;
    delete process.env.DUPSEARCH_OCR_AUTH_SCHEME;
  });

  it("uses local RapidOCR by default when no remote OCR provider is configured", async () => {
    const localRapidOcrRunner = vi.fn().mockResolvedValue({ text: "  local image text  " });

    await expect(
      recognizeImageText(
        { imageUrl: "data:image/png;base64,aW1hZ2U=" },
        process.env,
        { localRapidOcrRunner },
      ),
    ).resolves.toEqual({ text: "local image text" });

    expect(localRapidOcrRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        imageBase64: "aW1hZ2U=",
        mimeType: "image/png",
        config: expect.objectContaining({
          provider: "local-rapidocr",
        }),
      }),
    );
  });

  it("rejects when the remote OCR provider is selected without a URL", async () => {
    process.env.DUPSEARCH_OCR_PROVIDER = "remote";

    await expect(
      recognizeImageText({ imageUrl: "data:image/png;base64,aW1hZ2U=" }),
    ).rejects.toThrow(/ocr provider is not configured/i);
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

    vi.stubGlobal("fetch", fetchMock);
    process.env.DUPSEARCH_OCR_URL = "https://example.test/ocr";
    process.env.DUPSEARCH_OCR_API_KEY = "ocr-key";

    await expect(
      recognizeImageText({ imageUrl: "data:image/png;base64,aW1hZ2U=" }),
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
          image: "aW1hZ2U=",
          mime: "image/png",
          imageUrl: undefined,
        }),
      }),
    );
  });
});