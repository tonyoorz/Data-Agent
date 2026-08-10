import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createLocalAsrWorker, handleTranscribeRequest, transcribeAudio } from "../../../server/transcribe.mjs";

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUPSEARCH_TRANSCRIBE_URL;
    delete process.env.DUPSEARCH_TRANSCRIBE_API_KEY;
    delete process.env.DUPSEARCH_TRANSCRIBE_ACCESS_CODE;
    delete process.env.DUPSEARCH_CHAT_ACCESS_CODE;
    delete process.env.DUPSEARCH_TRANSCRIBE_PROVIDER;
    delete process.env.DUPSEARCH_LOCAL_ASR_MODEL;
    delete process.env.DUPSEARCH_LOCAL_ASR_DEVICE;
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
      "https://aistudio.bmwbrill.cn/api/service/49/internal-access-code/asr?task=transcribe",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );

    const requestOptions = fetchMock.mock.calls[0][1] as { body: FormData };
    const audioFile = requestOptions.body.get("audio_file");
    expect(audioFile).toBeInstanceOf(Blob);
  });

  it("uses the local FunASR provider when configured", async () => {
    const localAsrRunner = vi.fn().mockResolvedValue({ text: "  local voice text  " });
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    process.env.DUPSEARCH_TRANSCRIBE_PROVIDER = "local-funasr";
    process.env.DUPSEARCH_CHAT_ACCESS_CODE = "chat-access-code";
    process.env.DUPSEARCH_LOCAL_ASR_MODEL = "C:\\models\\SenseVoiceSmall";
    process.env.DUPSEARCH_LOCAL_ASR_DEVICE = "cuda:0";

    await expect(
      transcribeAudio(
        { audioBase64: "Zm9v", mimeType: "audio/webm" },
        process.env,
        { localAsrRunner },
      ),
    ).resolves.toEqual({ text: "local voice text" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(localAsrRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        audioBase64: "Zm9v",
        mimeType: "audio/webm",
        config: expect.objectContaining({
          localModel: "C:\\models\\SenseVoiceSmall",
          localDevice: "cuda:0",
        }),
      }),
    );
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

  it("reuses a local ASR worker process for multiple transcriptions", async () => {
    class FakeChild extends EventEmitter {
      public stdin = new PassThrough();
      public stdout = new PassThrough();
      public stderr = new PassThrough();
      public kill = vi.fn();

      constructor() {
        super();
        this.stdin.on("data", (chunk) => {
          for (const line of String(chunk).trim().split("\n")) {
            if (!line) continue;
            const request = JSON.parse(line);
            this.stdout.write(JSON.stringify({ id: request.id, text: `text:${request.audio}` }) + "\n");
          }
        });
      }
    }

    const fakeChild = new FakeChild();
    const spawnProcess = vi.fn(() => fakeChild);
    const worker = createLocalAsrWorker(
      {
        localPython: "python",
        localScript: "backend/local_asr.py",
        localModel: "C:\\models\\SenseVoiceSmall",
        localDevice: "cuda:0",
        localTimeoutMs: 1000,
      },
      { spawnProcess },
    );

    await expect(worker.transcribe({ audioBase64: "one", mimeType: "audio/webm" })).resolves.toEqual({ text: "text:one" });
    await expect(worker.transcribe({ audioBase64: "two", mimeType: "audio/webm" })).resolves.toEqual({ text: "text:two" });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    worker.dispose();
    expect(fakeChild.kill).toHaveBeenCalled();
  });
});