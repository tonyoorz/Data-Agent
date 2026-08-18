import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  createLocalAsrWorker,
  handleTranscribeRequest,
  toSafeTranscriptionError,
  transcribeAudio,
} from "../../../server/transcribe.mjs";

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUPSEARCH_TRANSCRIBE_URL;
    delete process.env.DUPSEARCH_TRANSCRIBE_API_KEY;
    delete process.env.DUPSEARCH_TRANSCRIBE_ACCESS_CODE;
    delete process.env.DUPSEARCH_TRANSCRIBE_ENDPOINT;
    delete process.env.DUPSEARCH_TRANSCRIBE_TIMEOUT_MS;
    delete process.env.DUPSEARCH_CHAT_ACCESS_CODE;
    delete process.env.DUPSEARCH_TRANSCRIBE_PROVIDER;
    delete process.env.DUPSEARCH_LOCAL_ASR_MODEL;
    delete process.env.DUPSEARCH_LOCAL_ASR_DEVICE;
    delete process.env.DUPSEARCH_BEACON_DOUBAO_ASR_URL;
    delete process.env.DUPSEARCH_BEACON_DOUBAO_ASR_API_KEY;
    delete process.env.DUPSEARCH_BEACON_DOUBAO_ASR_MODEL;
    delete process.env.DUPSEARCH_BEACON_DOUBAO_ASR_REQUEST_FORMAT;
    delete process.env.DUPSEARCH_BEACON_DOUBAO_ASR_FALLBACK_TO_LOCAL;
  });

  it("rejects when no transcription provider is configured", async () => {
    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).rejects.toThrow("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
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
    process.env.DUPSEARCH_TRANSCRIBE_PROVIDER = "remote";

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
        redirect: "error",
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
    process.env.DUPSEARCH_TRANSCRIBE_PROVIDER = "company";

    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).resolves.toEqual({ text: "recognized by whisper" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://aistudio.bmwbrill.cn/api/service/49/internal-access-code/asr?task=transcribe",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
        redirect: "error",
      }),
    );

    const requestOptions = fetchMock.mock.calls[0][1] as { body: FormData };
    const audioFile = requestOptions.body.get("audio_file");
    expect(audioFile).toBeInstanceOf(Blob);
  });

  it("lets an explicit remote transcription URL take precedence over company credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "remote provider" }),
      headers: { get: () => "application/json" },
    });

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
        DUPSEARCH_TRANSCRIBE_ACCESS_CODE: "company-asr-code",
        DUPSEARCH_CHAT_ACCESS_CODE: "unrelated-chat-code",
        DUPSEARCH_TRANSCRIBE_PROVIDER: "remote",
      },
      { fetchImpl: fetchMock },
    )).resolves.toEqual({ text: "remote provider" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://asr.example.test/transcribe",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer asr-key" }),
        redirect: "error",
      }),
    );
  });

  it.each([
    "http://asr.example.test/transcribe",
    "https://user:password@asr.example.test/transcribe",
    "https://asr.example.test/transcribe?token=secret",
  ])("rejects unsafe remote transcription URLs (%s)", async (url) => {
    const fetchMock = vi.fn();

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_PROVIDER: "remote",
        DUPSEARCH_TRANSCRIBE_URL: url,
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
      },
      { fetchImpl: fetchMock },
    )).rejects.toThrow("TRANSCRIPTION_ENDPOINT_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsafe company transcription endpoint template", async () => {
    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_ACCESS_CODE: "company-code",
        DUPSEARCH_TRANSCRIBE_ENDPOINT: "http://asr.example.test/{accessCode}/transcribe",
        DUPSEARCH_TRANSCRIBE_PROVIDER: "company",
      },
      { fetchImpl: vi.fn() },
    )).rejects.toThrow("TRANSCRIPTION_ENDPOINT_INVALID");
  });

  it.each(["0", "300001", "invalid"])('rejects invalid remote timeout "%s"', async (timeoutMs) => {
    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
        DUPSEARCH_TRANSCRIBE_PROVIDER: "remote",
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
        DUPSEARCH_TRANSCRIBE_TIMEOUT_MS: timeoutMs,
      },
      { fetchImpl: vi.fn() },
    )).rejects.toThrow("TRANSCRIPTION_TIMEOUT_INVALID");
  });

  it("rejects a transcription auth scheme that could inject headers", async () => {
    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
        DUPSEARCH_TRANSCRIBE_PROVIDER: "remote",
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
        DUPSEARCH_TRANSCRIBE_AUTH_SCHEME: "Bearer\r\nX-Leak",
      },
      { fetchImpl: vi.fn() },
    )).rejects.toThrow("TRANSCRIPTION_AUTH_SCHEME_INVALID");
  });

  it("does not read or expose an upstream error body", async () => {
    const readBody = vi.fn().mockResolvedValue("provider secret and transcript");
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      body: { cancel },
      text: readBody,
      json: readBody,
    });

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_PROVIDER: "remote",
        DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
      },
      { fetchImpl: fetchMock },
    )).rejects.toThrow("TRANSCRIPTION_UPSTREAM_HTTP_ERROR");
    expect(readBody).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("maps remote timeouts to a stable error code", async () => {
    const timeoutError = Object.assign(new Error("provider details"), { name: "TimeoutError" });
    const fetchMock = vi.fn().mockRejectedValue(timeoutError);

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_PROVIDER: "remote",
        DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
      },
      { fetchImpl: fetchMock },
    )).rejects.toThrow("TRANSCRIPTION_UPSTREAM_TIMEOUT");
  });

  it("keeps the deadline active while an upstream response body is still pending", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      requestSignal = init.signal;
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: () => new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("body aborted"), { name: "AbortError" }));
          }, { once: true });
        }),
      };
    });

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_PROVIDER: "remote",
        DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
        DUPSEARCH_TRANSCRIBE_TIMEOUT_MS: "5",
      },
      { fetchImpl },
    )).rejects.toThrow("TRANSCRIPTION_UPSTREAM_TIMEOUT");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("never reuses chat credentials as transcription credentials", async () => {
    const fetchMock = vi.fn();

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      { DUPSEARCH_CHAT_ACCESS_CODE: "chat-only-secret" },
      { fetchImpl: fetchMock },
    )).rejects.toThrow("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit remote provider and dedicated key before audio can leave the process", async () => {
    const fetchImpl = vi.fn();
    const baseConfig = {
      DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
      DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
    };

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      baseConfig,
      { fetchImpl },
    )).rejects.toThrow("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      { ...baseConfig, DUPSEARCH_TRANSCRIBE_PROVIDER: "remote", DUPSEARCH_TRANSCRIBE_API_KEY: "" },
      { fetchImpl },
    )).rejects.toThrow("TRANSCRIPTION_API_KEY_REQUIRED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an explicit provider when company and remote credentials are both configured", async () => {
    const fetchImpl = vi.fn();

    await expect(transcribeAudio(
      { audioBase64: "Zm9v", mimeType: "audio/webm" },
      {
        DUPSEARCH_TRANSCRIBE_ACCESS_CODE: "company-code",
        DUPSEARCH_TRANSCRIBE_URL: "https://asr.example.test/transcribe",
        DUPSEARCH_TRANSCRIBE_API_KEY: "asr-key",
      },
      { fetchImpl },
    )).rejects.toThrow("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("uses the configured Beacon Doubao batch endpoint without exposing its credential to callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "  beacon transcript  " }),
      text: async () => "",
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
    });

    vi.stubGlobal("fetch", fetchMock);
    process.env.DUPSEARCH_TRANSCRIBE_PROVIDER = "beacon-doubao";
    process.env.DUPSEARCH_BEACON_DOUBAO_ASR_URL = "https://beacon.example.test/asr";
    process.env.DUPSEARCH_BEACON_DOUBAO_ASR_API_KEY = "beacon-server-token";

    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).resolves.toEqual({ text: "beacon transcript", provider: "beacon-doubao", fallback: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://beacon.example.test/asr",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer beacon-server-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model: "Doubao-ASR-Async",
          audio: "Zm9v",
          mime: "audio/webm",
        }),
      }),
    );
  });

  it("falls back to local FunASR when Beacon Doubao transcription fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "temporary upstream failure",
    });
    const localAsrRunner = vi.fn().mockResolvedValue({ text: "local fallback transcript" });

    vi.stubGlobal("fetch", fetchMock);
    process.env.DUPSEARCH_TRANSCRIBE_PROVIDER = "beacon-doubao";
    process.env.DUPSEARCH_BEACON_DOUBAO_ASR_URL = "https://beacon.example.test/asr";
    process.env.DUPSEARCH_BEACON_DOUBAO_ASR_API_KEY = "beacon-server-token";

    await expect(
      transcribeAudio(
        { audioBase64: "Zm9v", mimeType: "audio/webm" },
        process.env,
        { localAsrRunner },
      ),
    ).resolves.toEqual({ text: "local fallback transcript", provider: "local-funasr", fallback: true });

    expect(localAsrRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        audioBase64: "Zm9v",
        mimeType: "audio/webm",
      }),
    );
  });

  it("validates request payload and wraps the transcript for the local API", async () => {
    process.env.DUPSEARCH_TRANSCRIBE_URL = "https://example.test/transcribe";
    process.env.DUPSEARCH_TRANSCRIBE_API_KEY = "test-key";
    process.env.DUPSEARCH_TRANSCRIBE_PROVIDER = "remote";

    await expect(handleTranscribeRequest({})).rejects.toThrow("TRANSCRIPTION_AUDIO_REQUIRED");

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

  it("maps only allowlisted transcription failures to typed client responses", () => {
    expect(toSafeTranscriptionError(Object.assign(new Error("provider body"), {
      code: "TRANSCRIPTION_UPSTREAM_TIMEOUT",
    }))).toEqual({
      statusCode: 504,
      payload: { success: false, error: "TRANSCRIPTION_UPSTREAM_TIMEOUT" },
    });
    expect(toSafeTranscriptionError(new Error("provider body"))).toEqual({
      statusCode: 500,
      payload: { success: false, error: "TRANSCRIPTION_REQUEST_FAILED" },
    });
  });
});
