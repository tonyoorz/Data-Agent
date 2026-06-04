const DEFAULT_COMPANY_TRANSCRIBE_ENDPOINT =
  "https://aistudio.bmwbrill.cn/api/service/49/{accessCode}/asr";

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

export function resolveTranscribeConfig(env = process.env) {
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
    url: readFirst(env, ["DUPSEARCH_TRANSCRIBE_URL", "TRANSCRIBE_URL"]),
    apiKey: readFirst(env, ["DUPSEARCH_TRANSCRIBE_API_KEY", "TRANSCRIBE_API_KEY"]),
    authScheme: readFirst(env, ["DUPSEARCH_TRANSCRIBE_AUTH_SCHEME", "TRANSCRIBE_AUTH_SCHEME"]) || "Bearer",
    companyAccessCode,
    companyEndpointTemplate,
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

async function parseTranscriptionResponse(response) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();

  if (contentType.includes("application/json") || (!contentType && typeof response.json === "function")) {
    return normalizeText(await response.json());
  }

  return normalizeText(await response.text());
}

export async function transcribeAudio({ audioBase64, mimeType }, env = process.env) {
  const config = resolveTranscribeConfig(env);

  if (config.companyEndpointTemplate && config.companyAccessCode) {
    const url = `${config.companyEndpointTemplate.replace("{accessCode}", config.companyAccessCode)}?task=transcribe&output=txt`;
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