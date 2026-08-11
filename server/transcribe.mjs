import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_COMPANY_TRANSCRIBE_ENDPOINT =
  "https://aistudio.bmwbrill.cn/api/service/49/{accessCode}/asr";
const DEFAULT_BEACON_DOUBAO_ASR_MODEL = "Doubao-ASR-Async";

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
    "DUPSEARCH_CHAT_ACCESS_CODE",
    "ACCESS_CODE",
    "DEEPSEEK_ACCESS_CODE",
  ]);
  const companyEndpointTemplate = readFirst(env, [
    "DUPSEARCH_TRANSCRIBE_ENDPOINT",
    "TRANSCRIBE_ENDPOINT",
  ]) || (companyAccessCode ? DEFAULT_COMPANY_TRANSCRIBE_ENDPOINT : "");

  return {
    provider,
    url: readFirst(env, ["DUPSEARCH_TRANSCRIBE_URL", "TRANSCRIBE_URL"]),
    apiKey: readFirst(env, ["DUPSEARCH_TRANSCRIBE_API_KEY", "TRANSCRIBE_API_KEY"]),
    authScheme: readFirst(env, ["DUPSEARCH_TRANSCRIBE_AUTH_SCHEME", "TRANSCRIBE_AUTH_SCHEME"]) || "Bearer",
    companyAccessCode,
    companyEndpointTemplate,
    beaconDoubaoUrl: readFirst(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_URL",
      "BEACON_DOUBAO_ASR_URL",
    ]),
    beaconDoubaoApiKey: readFirst(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_API_KEY",
      "BEACON_DOUBAO_ASR_API_KEY",
      "DUPSEARCH_BEACON_API_KEY",
      "BEACON_API_KEY",
    ]),
    beaconDoubaoAuthScheme: readFirst(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_AUTH_SCHEME",
      "BEACON_DOUBAO_ASR_AUTH_SCHEME",
    ]) || "Bearer",
    beaconDoubaoModel: readFirst(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_MODEL",
      "BEACON_DOUBAO_ASR_MODEL",
    ]) || DEFAULT_BEACON_DOUBAO_ASR_MODEL,
    beaconDoubaoFallbackToLocal: readBoolean(env, [
      "DUPSEARCH_BEACON_DOUBAO_ASR_FALLBACK_TO_LOCAL",
      "BEACON_DOUBAO_ASR_FALLBACK_TO_LOCAL",
    ], true),
    localPython: readFirst(env, ["DUPSEARCH_LOCAL_ASR_PYTHON", "LOCAL_ASR_PYTHON"]) || defaultLocalAsrPython(env),
    localScript: readFirst(env, ["DUPSEARCH_LOCAL_ASR_SCRIPT", "LOCAL_ASR_SCRIPT"]) || path.join(repoRoot, "backend", "local_asr.py"),
    localModel: readFirst(env, ["DUPSEARCH_LOCAL_ASR_MODEL", "LOCAL_ASR_MODEL"]) || defaultLocalAsrModel(),
    localDevice: readFirst(env, ["DUPSEARCH_LOCAL_ASR_DEVICE", "LOCAL_ASR_DEVICE"]) || "cuda:0",
    localTimeoutMs: Number(readFirst(env, ["DUPSEARCH_LOCAL_ASR_TIMEOUT_MS", "LOCAL_ASR_TIMEOUT_MS"]) || 180000),
  };
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
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
    },
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

async function transcribeWithBeaconDoubao({ audioBase64, mimeType, config }) {
  if (!config.beaconDoubaoUrl) {
    throw new Error("Beacon Doubao ASR endpoint is not configured");
  }
  if (!config.beaconDoubaoApiKey) {
    throw new Error("Beacon Doubao ASR API key is not configured");
  }

  const response = await fetch(config.beaconDoubaoUrl, {
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
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Beacon Doubao transcription failed (${response.status}): ${message || response.statusText}`);
  }

  const text = await parseTranscriptionResponse(response);
  if (!text) {
    throw new Error("Beacon Doubao ASR returned empty text");
  }

  return { text, provider: "beacon-doubao", fallback: false };
}

async function parseTranscriptionResponse(response) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();

  if (contentType.includes("application/json") || (!contentType && typeof response.json === "function")) {
    return normalizeText(await response.json());
  }

  return normalizeText(await response.text());
}

export async function transcribeAudio({ audioBase64, mimeType }, env = process.env, dependencies = {}) {
  const config = resolveTranscribeConfig(env);

  if (isLocalAsrProvider(config.provider)) {
    return await transcribeWithLocalAsr({ audioBase64, mimeType, config, dependencies });
  }

  if (isBeaconDoubaoProvider(config.provider)) {
    try {
      return await transcribeWithBeaconDoubao({ audioBase64, mimeType, config });
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

  if (config.companyEndpointTemplate && config.companyAccessCode) {
    const url = `${config.companyEndpointTemplate.replace("{accessCode}", config.companyAccessCode)}?task=transcribe`;
    const formData = new FormData();
    const normalizedMimeType = String(mimeType || "audio/webm");
    const extension = getFileExtension(normalizedMimeType);
    formData.set(
      "audio_file",
      new Blob([decodeBase64Audio(audioBase64)], { type: normalizedMimeType }),
      `recording.${extension}`,
    );

    const response = await fetch(url, {
      method: "POST",
      body: formData,
      headers: {
        Accept: "text/plain",
      },
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(`Transcription request failed (${response.status}): ${message || response.statusText}`);
    }

    const text = await parseTranscriptionResponse(response);
    if (!text) {
      throw new Error("Transcription provider returned empty text");
    }

    return { text };
  }

  if (!config.url) {
    throw new Error("Transcription provider is not configured");
  }

  const response = await fetch(config.url, {
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
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Transcription request failed (${response.status}): ${message || response.statusText}`);
  }

  const text = await parseTranscriptionResponse(response);

  if (!text) {
    throw new Error("Transcription provider returned empty text");
  }

  return { text };
}

export async function handleTranscribeRequest(body, env = process.env) {
  const audioBase64 = String(body?.audio ?? "").trim();
  const mimeType = String(body?.mime ?? "audio/webm").trim() || "audio/webm";

  if (!audioBase64) {
    throw new Error("audio is required");
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