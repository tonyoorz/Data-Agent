import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  corsHeaders,
  handlePreflight,
  readBinaryBody,
  readJsonBody,
  writeHttpError,
  writeJson,
  writeSseHeaders,
} from "../../../../server/agentRuntime/httpUtils.mjs";

const makeRequest = (body = "", headers = {}) => Object.assign(Readable.from([Buffer.from(body)]), { headers });

function responseDouble() {
  const headers = {};
  return {
    headers,
    statusCode: undefined,
    body: "",
    setHeader: vi.fn((name, value) => { headers[name] = value; }),
    writeHead: vi.fn((statusCode, head = {}) => {
      response.statusCode = statusCode;
      Object.assign(headers, head);
    }),
    end: vi.fn((value = "") => { response.body += String(value); }),
  };
}

let response;

describe("Agent HTTP utilities", () => {
  it("rejects oversized JSON and binary bodies as soon as limits are exceeded", async () => {
    await expect(readJsonBody(makeRequest('{"x":"12345"}'), { maxBytes: 8 })).rejects.toMatchObject({ statusCode: 413, code: "REQUEST_TOO_LARGE" });
    await expect(readBinaryBody(makeRequest("abcdef"), { maxBytes: 5 })).rejects.toMatchObject({ statusCode: 413, code: "REQUEST_TOO_LARGE" });
    await expect(readJsonBody(makeRequest("not-json"), { maxBytes: 100 })).rejects.toMatchObject({ statusCode: 400, code: "INVALID_JSON" });
    await expect(readJsonBody(makeRequest('{"ok":true}'), { maxBytes: 100 })).resolves.toEqual({ ok: true });
  });

  it("applies explicit CORS headers to JSON, SSE and preflight responses", () => {
    const config = { allowedOrigins: ["https://vizion.example"] };
    const request = { headers: { origin: "https://vizion.example" } };

    response = responseDouble();
    writeJson(response, request, config, 201, { ok: true }, { "X-Agent-Run-ID": "run-1" });
    expect(response.statusCode).toBe(201);
    expect(response.headers).toMatchObject({
      "Access-Control-Allow-Origin": "https://vizion.example",
      "Access-Control-Allow-Credentials": "true",
      "content-type": "application/json; charset=utf-8",
      "X-Agent-Run-ID": "run-1",
    });
    expect(response.headers["Access-Control-Expose-Headers"].split(", ")).toEqual(expect.arrayContaining([
      "X-Agent-Protocol",
      "X-Agent-Run-ID",
      "X-Agent-Thread-ID",
      "X-Agent-Runtime-Mode",
      "X-Agent-API-Enabled",
      "X-Agent-Server-Controlled",
    ]));
    expect(JSON.parse(response.body)).toEqual({ ok: true });

    response = responseDouble();
    writeSseHeaders(response, request, config, { "X-Agent-Protocol": "1.0" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("https://vizion.example");

    response = responseDouble();
    handlePreflight(response, request, config);
    expect(response.statusCode).toBe(204);
    expect(response.headers["Access-Control-Allow-Methods"]).toContain("POST");
  });

  it("rejects disallowed origins and never allows wildcard credentials", () => {
    expect(() => corsHeaders("https://evil.example", { allowedOrigins: ["https://vizion.example"] })).toThrow(/ORIGIN_NOT_ALLOWED/);
    expect(() => corsHeaders("https://vizion.example", { allowedOrigins: ["*"] })).toThrow(/CORS_WILDCARD_FORBIDDEN/);
  });

  it("writes safe HTTP error payloads with CORS and retry headers", () => {
    response = responseDouble();
    writeHttpError(response, { headers: { origin: "https://vizion.example" } }, { allowedOrigins: ["https://vizion.example"] }, Object.assign(new Error("secret stack"), {
      statusCode: 429,
      code: "RUN_RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 3,
      safeMessage: "Too many runs.",
    }));

    expect(response.statusCode).toBe(429);
    expect(response.headers["Retry-After"]).toBe("3");
    expect(JSON.parse(response.body)).toEqual({ code: "RUN_RATE_LIMITED", safeMessage: "Too many runs.", retryable: true });
  });

  it("writes a real 403 response when CORS rejects the origin", () => {
    response = responseDouble();
    writeHttpError(
      response,
      { headers: { origin: "https://evil.example" } },
      { allowedOrigins: ["https://vizion.example"] },
      Object.assign(new Error("ORIGIN_NOT_ALLOWED"), { statusCode: 403, code: "ORIGIN_NOT_ALLOWED" }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.headers).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(JSON.parse(response.body)).toEqual({ code: "ORIGIN_NOT_ALLOWED", safeMessage: "ORIGIN_NOT_ALLOWED", retryable: false });
  });
});
