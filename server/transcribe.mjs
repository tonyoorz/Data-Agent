import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveLocalWorkerEnvironment } from "./localWorkerEnvironment.mjs";

const DEFAULT_COMPANY_TRANSCRIBE_ENDPOINT =
  "https://aistudio.bmwbrill.cn/api/service/49/{accessCode}/asr";
const DEFAULT_BEACON_DOUBAO_ASR_MODEL = "Doubao-ASR-Async";
const DEFAULT_REMOTE_TRANSCRIBE_TIMEOUT_MS = 60000;
const MAX_REMOTE_TRANSCRIBE_TIMEOUT_MS = 300000;
const LOOPBACK_TRANSCRIBE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const COMPANY_TRANSCRIBE_PROVIDERS = new Set(["company", "company-whisper", "internal", "whisper"]);
const REMOTE_TRANSCRIBE_PROVIDERS = new Set(["external", "openai-compatible", "remote"]);
const SAFE_TRANSCRIPTION_STATUS = Object.freeze({
  TRANSCRIPTION_AUDIO_REQUIRED: 400,
  TRANSCRIPTION_API_KEY_REQUIRED: 503,
  TRANSCRIPTION_AUTH_SCHEME_INVALID: 503,
  TRANSCRIPTION_ENDPOINT_INVALID: 503,
  TRANSCRIPTION_PROVIDER_INVALID: 503,
  TRANSCRIPTION_PROVIDER_NOT_CONFIGURED: 503,
  TRANSCRIPTION_TIMEOUT_INVALID: 503,
  TRANSCRIPTION_UPSTREAM_EMPTY_RESPONSE: 502,
  TRANSCRIPTION_UPSTREAM_HTTP_ERROR: 502,
  TRANSCRIPTION_UPSTREAM_INVALID_RESPONSE: 502,
  TRANSCRIPTION_UPSTREAM_TIMEOUT: 504,
  TRANSCRIPTION_UPSTREAM_UNAVAILABLE: 502,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readFirst(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

export class TranscriptionBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = "TranscriptionBoundaryError";
    this.code = code;
  }
}

function transcribeFail(code) {
  throw new TranscriptionBoundaryError(code);
}

export function toSafeTranscriptionError(error) {
  const code = Object.hasOwn(SAFE_TRANSCRIPTION_STATUS, error?.code)
    ? String(error.code)
    : "TRANSCRIPTION_REQUEST_FAILED";
  return {
    statusCode: SAFE_TRANSCRIPTION_STATUS[code] || 500,
    payload: { success: false, error: code },
  };
}

function secureTranscribeUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    transcribeFail("TRANSCRIPTION_ENDPOINT_INVALID");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || (url.protocol === "http:" && !LOOPBACK_TRANSCRIBE_HOSTS.has(url.hostname.toLowerCase()))
    || Boolean(url.username)
    || Boolean(url.password)
    || Boolean(url.search)
    || Boolean(url.hash)
  ) {
    transcribeFail("TRANSCRIPTION_ENDPOINT_INVALID");
  }
  return url.toString();
}

function secureCompanyEndpointTemplate(value) {
  const template = String(value || "").trim();
  if (template.split("{accessCode}").length !== 2) {
    transcribeFail("TRANSCRIPTION_ENDPOINT_INVALID");
  }
  secureTranscribeUrl(template.replace("{accessCode}", "validated-access-code"));
  return template;
}

function resolveRemoteTimeoutMs(env) {
  const raw = readFirst(env, ["DUPSEARCH_TRANSCRIBE_TIMEOUT_MS", "TRANSCRIBE_TIMEOUT_MS"]);
  if (!raw) return DEFAULT_REMOTE_TRANSCRIBE_TIMEOUT_MS;
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REMOTE_TRANSCRIBE_TIMEOUT_MS) {
    transcribeFail("TRANSCRIPTION_TIMEOUT_INVALID");
  }
  return timeoutMs;
}

function normalizeAuthScheme(value) {
  const scheme = String(value || "Bearer").trim() || "Bearer";
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/u.test(scheme)) {
    transcribeFail("TRANSCRIPTION_AUTH_SCHEME_INVALID");
  }
  return scheme;
}

function normalizeText(payload) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  if (typeof payload?.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }

  if (typeof payload?.subtitles === "string" && payload.subtitles.trim()) {
    return payload.subtitles.trim();
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  return "";
}

function readBoolean(env, keys, fallback) {
  const value = readFirst(env, keys).toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export function resolveTranscribeConfig(env = process.env) {
  const provider = readFirst(env, [
    "DUPSEARCH_TRANSCRIBE_PROVIDER",
    "TRANSCRIBE_PROVIDER",
  ]).toLowerCase();
  const companyAccessCode = readFirst(env, [
    "DUPSEARCH_TRANSCRIBE_ACCESS_CODE",
    "TRANSCRIBE_ACCESS_CODE",
  ]);
  const configuredCompanyEndpoint = readFirst(env, [
    "DUPSEARCH_TRANSCRIBE_ENDPOINT",
    "TRANSCRIBE_ENDPOINT",
  ]);
  const companyEndpointTemplate = configuredCompanyEndpoint || (companyAccessCode ? DEFAULT_COMPANY_TRANSCRIBE_ENDPOINT : "");
  const configuredUrl = readFirst(env, ["DUPSEARCH_TRANSCRIBE_URL", "TRANSCRIBE_URL"]);
  const configuredBeaconUrl = readFirst(env, ["DUPSEARCH_BEACON_DOUBAO_ASR_URL", "BEACON_DOUBAO_ASR_URL"]);

  return {
    provider,
    url: configuredUrl ? secureTranscribeUrl(configuredUrl) : "",
    apiKey: readFirst(env, ["DUPSEARCH_TRANSCRIBE_API_KEY", "TRANSCRIBE_API_KEY"]),
    authScheme: normalizeAuthScheme(readFirst(env, ["DUPSEARCH_TRANSCRIBE_AUTH_SCHEME", "TRANSCRIBE_AUTH_SCHEME"])),
    companyAccessCode,
    companyEndpointTemplate: companyEndpointTemplate ? secureCompanyEndpointTemplate(companyEndpointTemplate) : "",
    beaconDoubaoUrl: configuredBeaconUrl ? secureTranscribeUrl(configuredBeaconUrl) : "",
    beaconDoubaoApiKey: readFirst(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_API_KEY",
      "BEACON_DOUBAO_ASR_API_KEY",
      "DUPSEARCH_BEACON_API_KEY",
      "BEACON_API_KEY",
    ]),
    beaconDoubaoAuthScheme: normalizeAuthScheme(readFirst(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_AUTH_SCHEME",
      "BEACON_DOUBAO_ASR_AUTH_SCHEME",
    ])),
    beaconDoubaoModel: readFirst(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_MODEL",
      "BEACON_DOUBAO_ASR_MODEL",
    ]) || DEFAULT_BEACON_DOUBAO_ASR_MODEL,
    beaconDoubaoFallbackToLocal: readBoolean(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_FALLBACK_TO_LOCAL",
      "BEACON_DOUBAO_ASR_FALLBACK_TO_LOCAL",
    ], true),
    remoteTimeoutMs: resolveRemoteTimeoutMs(env),
    localPython: readFirst(env, ["DUPSEARCH_LOCAL_ASR_PYTHON", "LOCAL_ASR_PYTHON"]) || defaultLocalAsrPython(env),
    localScript: readFirst(env, ["DUPSEARCH_LOCAL_ASR_SCRIPT", "LOCAL_ASR_SCRIPT"]) || path.join(repoRoot, "backend", "local_asr.py"),
    localModel: readFirst(env, ["DUPSEARCH_LOCAL_ASR_MODEL", "LOCAL_ASR_MODEL"]) || defaultLocalAsrModel(),
    localDevice: readFirst(env, ["DUPSEARCH_LOCAL_ASR_DEVICE", "LOCAL_ASR_DEVICE"]) || "cuda:0",
    localTimeoutMs: Number(readFirst(env, ["DUPSEARCH_LOCAL_ASR_TIMEOUT_MS", "LOCAL_ASR_TIMEOUT_MS"]) || 180000),
  };
}

function resolveTranscribeMode(config) {
  if (isLocalAsrProvider(config.provider)) return "local";
  if (isBeaconDoubaoProvider(config.provider)) {
    if (!config.beaconDoubaoUrl) transcribeFail("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
    if (!config.beaconDoubaoApiKey) transcribeFail("TRANSCRIPTION_API_KEY_REQUIRED");
    return "beacon";
  }
  if (COMPANY_TRANSCRIBE_PROVIDERS.has(config.provider)) {
    if (!config.companyAccessCode || !config.companyEndpointTemplate) {
      transcribeFail("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
    }
    return "company";
  }
  if (REMOTE_TRANSCRIBE_PROVIDERS.has(config.provider)) {
    if (!config.url) transcribeFail("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
    if (!config.apiKey) transcribeFail("TRANSCRIPTION_API_KEY_REQUIRED");
    return "remote";
  }
  if (config.provider) transcribeFail("TRANSCRIPTION_PROVIDER_INVALID");
  transcribeFail("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
}

function getFileExtension(mimeType) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function decodeBase64Audio(audioBase64) {
  return Uint8Array.from(Buffer.from(String(audioBase64 || ""), "base64"));
}

function localAsrWorkerKey(config) {
  return [config.localPython, config.localScript, config.localModel, config.localDevice].join("|");
}

const localAsrWorkers = new Map();

export function createLocalAsrWorker(config, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess || spawn;
  const child = spawnProcess(config.localPython, [config.localScript, "--server"], {
    cwd: repoRoot,
    env: resolveLocalWorkerEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;

  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (rawLine) {
        try {
          const message = JSON.parse(rawLine);
          const entry = pending.get(message.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(message.id);
            if (message.error) {
              entry.reject(new Error(String(message.error)));
            } else {
              entry.resolve({ text: message.text });
            }
          }
        } catch {
          stderrBuffer = `${stderrBuffer}${rawLine}\n`.slice(-4000);
        }
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4000);
  });
  child.on("error", (error) => {
    closed = true;
    rejectAll(error);
  });
  child.on("close", (code) => {
    closed = true;
    rejectAll(new Error(`Local ASR worker exited (${code ?? 0}): ${stderrBuffer.trim()}`));
  });

  return {
    transcribe({ audioBase64, mimeType }) {
      if (closed) {
        return Promise.reject(new Error("Local ASR worker is not running"));
      }
      const id = String(nextId++);
      const timeoutMs = Number.isFinite(config.localTimeoutMs) ? config.localTimeoutMs : 180000;
      const payload = JSON.stringify({
        id,
        audio: String(audioBase64 || ""),
        mime: String(mimeType || "audio/webm"),
        model: config.localModel,
        device: config.localDevice,
      });

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Local ASR timed out after ${timeoutMs}ms: ${stderrBuffer.trim()}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${payload}\n`, "utf8", (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
    dispose() {
      closed = true;
      rejectAll(new Error("Local ASR worker disposed"));
      child.kill("SIGTERM");
    },
  };
}

function getLocalAsrWorker(config) {
  const key = localAsrWorkerKey(config);
  let worker = localAsrWorkers.get(key);
  if (!worker) {
    worker = createLocalAsrWorker(config);
    localAsrWorkers.set(key, worker);
  }
  return worker;
}

export async function runLocalAsrTranscription({ audioBase64, mimeType, config }) {
  return await getLocalAsrWorker(config).transcribe({ audioBase64, mimeType });
}

async function transcribeWithLocalAsr({ audioBase64, mimeType, config, dependencies }) {
  const result = await (dependencies.localAsrRunner || runLocalAsrTranscription)({
    audioBase64,
    mimeType,
    config,
  });
  const text = normalizeText(result);
  if (!text) {
    throw new Error("Local ASR returned empty text");
  }

  return { text };
}

async function transcribeWithBeaconDoubao({ audioBase64, mimeType, config, dependencies = {} }) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") transcribeFail("TRANSCRIPTION_UPSTREAM_UNAVAILABLE");
  const signal = createRemoteTimeoutSignal(config.remoteTimeoutMs, dependencies);
  const text = await requestTranscription(fetchImpl, config.beaconDoubaoUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `${config.beaconDoubaoAuthScheme} ${config.beaconDoubaoApiKey}`.trim(),
    },
    body: JSON.stringify({
      model: config.beaconDoubaoModel,
      audio: String(audioBase64 || ""),
      mime: String(mimeType || "audio/webm"),
    }),
  }, signal);

  return { text, provider: "beacon-doubao", fallback: false };
}

async function parseTranscriptionResponse(response) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();

  if (contentType.includes("application/json") || (!contentType && typeof response.json === "function")) {
    return normalizeText(await response.json());
  }

  return normalizeText(await response.text());
}

function isTimeoutError(error, signal) {
  return signal?.aborted === true
    || error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || error?.code === "ABORT_ERR";
}

function createRemoteTimeoutSignal(timeoutMs, dependencies) {
  if (dependencies.signal) return dependencies.signal;
  const timeoutSignal = dependencies.timeoutSignal || ((durationMs) => AbortSignal.timeout(durationMs));
  return timeoutSignal(timeoutMs);
}

async function requestTranscription(fetchImpl, url, options, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isTimeoutError(error, signal)) transcribeFail("TRANSCRIPTION_UPSTREAM_TIMEOUT");
    transcribeFail("TRANSCRIPTION_UPSTREAM_UNAVAILABLE");
  }

  if (!response?.ok) {
    try {
      response?.body?.cancel?.().catch?.(() => {});
    } catch {
      // Ignore disposal errors while preserving the stable boundary error.
    }
    transcribeFail("TRANSCRIPTION_UPSTREAM_HTTP_ERROR");
  }

  try {
    const text = await parseTranscriptionResponse(response);
    if (!text) transcribeFail("TRANSCRIPTION_UPSTREAM_EMPTY_RESPONSE");
    return text;
  } catch (error) {
    if (error instanceof TranscriptionBoundaryError) throw error;
    if (isTimeoutError(error, signal)) transcribeFail("TRANSCRIPTION_UPSTREAM_TIMEOUT");
    transcribeFail("TRANSCRIPTION_UPSTREAM_INVALID_RESPONSE");
  }
}

export async function transcribeAudio({ audioBase64, mimeType }, env = process.env, dependencies = {}) {
  const config = resolveTranscribeConfig(env);
  const mode = resolveTranscribeMode(config);

  if (mode === "local") {
    return transcribeWithLocalAsr({ audioBase64, mimeType, config, dependencies });
  }

  if (mode === "beacon") {
    try {
      return await transcribeWithBeaconDoubao({ audioBase64, mimeType, config, dependencies });
    } catch (beaconError) {
      if (!config.beaconDoubaoFallbackToLocal) {
        throw beaconError;
      }

      try {
        const fallback = await transcribeWithLocalAsr({ audioBase64, mimeType, config, dependencies });
        return { ...fallback, provider: "local-funasr", fallback: true };
      } catch (localError) {
        const beaconMessage = beaconError instanceof Error ? beaconError.message : "Unknown Beacon Doubao error";
        const localMessage = localError instanceof Error ? localError.message : "Unknown local ASR error";
        throw new Error(`${beaconMessage}; local fallback failed: ${localMessage}`);
      }
    }
  }

  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") transcribeFail("TRANSCRIPTION_UPSTREAM_UNAVAILABLE");
  const signal = createRemoteTimeoutSignal(config.remoteTimeoutMs, dependencies);

  if (mode === "company") {
    const companyUrl = new URL(secureTranscribeUrl(
      config.companyEndpointTemplate.replace("{accessCode}", encodeURIComponent(config.companyAccessCode)),
    ));
    companyUrl.searchParams.set("task", "transcribe");
    const formData = new FormData();
    const normalizedMimeType = String(mimeType || "audio/webm");
    const extension = getFileExtension(normalizedMimeType);
    formData.set(
      "audio_file",
      new Blob([decodeBase64Audio(audioBase64)], { type: normalizedMimeType }),
      `recording.${extension}`,
    );

    const text = await requestTranscription(fetchImpl, companyUrl.toString(), {
      method: "POST",
      body: formData,
      headers: {
        Accept: "text/plain",
      },
    }, signal);

    return { text };
  }

  const text = await requestTranscription(fetchImpl, config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey
        ? {
            Authorization: `${config.authScheme} ${config.apiKey}`.trim(),
          }
        : {}),
    },
    body: JSON.stringify({
      audio: String(audioBase64 || ""),
      mime: String(mimeType || "audio/webm"),
    }),
  }, signal);

  return { text };
}

export async function handleTranscribeRequest(body, env = process.env) {
  const audioBase64 = String(body?.audio ?? "").trim();
  const mimeType = String(body?.mime ?? "audio/webm").trim() || "audio/webm";

  if (!audioBase64) {
    transcribeFail("TRANSCRIPTION_AUDIO_REQUIRED");
  }

  const result = await transcribeAudio({ audioBase64, mimeType }, env);
  return {
    success: true,
    text: result.text,
  };
}

function defaultLocalAsrPython(env = process.env) {
  const candidates = [
    env.VIZION_ASR_PYTHON,
    env.VIZION_ANALYTICS_PYTHON,
    env.DUPSEARCH_AGENT_PYTHON,
    path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"),
    "python",
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === "python" || fs.existsSync(candidate)) return candidate;
  }

  return "python";
}

function defaultLocalAsrModel() {
  const cachedModel = path.join(os.homedir(), ".cache", "modelscope", "iic", "SenseVoiceSmall");
  return fs.existsSync(cachedModel) ? cachedModel : "iic/SenseVoiceSmall";
}

function isLocalAsrProvider(provider) {
  return ["local", "local-funasr", "funasr", "sensevoice"].includes(String(provider || "").toLowerCase());
}

function isBeaconDoubaoProvider(provider) {
  return String(provider || "").toLowerCase() === "beacon-doubao";
}
