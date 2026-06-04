import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleTranscribeRequest, transcribeAudio } from "../../../server/transcribe.mjs";

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUPSEARCH_TRANSCRIBE_URL;
    delete process.env.DUPSEARCH_TRANSCRIBE_API_KEY;
    delete process.env.DUPSEARCH_TRANSCRIBE_ACCESS_CODE;
    delete process.env.DUPSEARCH_CHAT_ACCESS_CODE;
  });

  it("rejects when no transcription provider is configured", async () => {
    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).rejects.toThrow(/not configured/i);
  });

  it("posts audio to the configured provider and returns trimmed text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "  transcribed text  " }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    process.env.DUPSEARCH_TRANSCRIBE_URL = "https://example.test/transcribe";
    process.env.DUPSEARCH_TRANSCRIBE_API_KEY = "test-key";

    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).resolves.toEqual({ text: "transcribed text" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/transcribe",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ audio: "Zm9v", mime: "audio/webm" }),
      }),
    );
  });

  it("uses the company whisper ASR endpoint when an access code is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "recognized by whisper",
      json: async () => ({ subtitles: "recognized by whisper" }),
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "text/plain" : null),
      },
    });

    vi.stubGlobal("fetch", fetchMock);
    process.env.DUPSEARCH_TRANSCRIBE_ACCESS_CODE = "internal-access-code";

    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).resolves.toEqual({ text: "recognized by whisper" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://aistudio.bmwbrill.cn/api/service/49/internal-access-code/asr?task=transcribe&output=txt",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );

    const requestOptions = fetchMock.mock.calls[0][1] as { body: FormData };
    const audioFile = requestOptions.body.get("audio_file");
    expect(audioFile).toBeInstanceOf(Blob);
  });

  it("validates request payload and wraps the transcript for the local API", async () => {
    process.env.DUPSEARCH_TRANSCRIBE_URL = "https://example.test/transcribe";

    await expect(handleTranscribeRequest({})).rejects.toThrow(/audio is required/i);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "voice text" }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      handleTranscribeRequest({ audio: "Zm9v", mime: "audio/webm" }),
    ).resolves.toEqual({ success: true, text: "voice text" });
  });
});