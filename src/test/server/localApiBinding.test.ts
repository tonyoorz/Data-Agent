// @vitest-environment node
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  LOCAL_API_HOST,
  buildLocalCorsHeaders,
  isJsonApiRequest,
  isTrustedLocalApiRequest,
  listenLocalApiServer,
  readBoundedJsonBody,
  resolveJsonBodyLimit,
  toSafeLocalApiBodyResponse,
} from "../../../server/localApiBinding.mjs";

function requestBody(chunks: Array<string | Buffer>, headers: Record<string, string> = {}) {
  const request = Readable.from(chunks);
  Object.assign(request, { headers });
  return request;
}

describe("local API network boundary", () => {
  it("uses a finite configurable JSON body limit", () => {
    expect(resolveJsonBodyLimit({})).toBe(DEFAULT_JSON_BODY_LIMIT_BYTES);
    expect(resolveJsonBodyLimit({ VIZION_API_JSON_BODY_LIMIT_BYTES: "2048" })).toBe(2048);
    expect(() => resolveJsonBodyLimit({ VIZION_API_JSON_BODY_LIMIT_BYTES: "0" })).toThrow(
      "maxBytes must be a positive safe integer",
    );
  });

  it("binds the local API to IPv4 loopback", () => {
    const token = Symbol("server");
    const server = { listen: vi.fn(() => token) };
    const onListening = vi.fn();

    expect(listenLocalApiServer(server, 3004, onListening)).toBe(token);
    expect(LOCAL_API_HOST).toBe("127.0.0.1");
    expect(server.listen).toHaveBeenCalledWith(3004, "127.0.0.1", onListening);
  });

  it("accepts only the configured API Host and configured local UI/API origins", () => {
    const options = { apiPort: 3004, webPort: 8080 };

    expect(isTrustedLocalApiRequest({ headers: { host: "127.0.0.1:3004" } }, options)).toBe(true);
    expect(isTrustedLocalApiRequest({
      headers: { host: "localhost:3004", origin: "http://localhost:8080" },
    }, options)).toBe(true);
    expect(isTrustedLocalApiRequest({
      headers: { host: "127.0.0.1:3004", origin: "http://127.0.0.1:3004" },
    }, options)).toBe(true);
  });

  it.each([
    ["missing Host", {}],
    ["Host without the configured port", { host: "localhost" }],
    ["non-loopback Host", { host: "attacker.example:3004" }],
    ["wrong Host port", { host: "localhost:8080" }],
    ["non-loopback Origin", { host: "localhost:3004", origin: "https://attacker.example" }],
    ["HTTPS local Origin", { host: "localhost:3004", origin: "https://localhost:8080" }],
    ["wrong local Origin port", { host: "localhost:3004", origin: "http://localhost:9000" }],
    ["opaque Origin", { host: "localhost:3004", origin: "null" }],
    ["Origin credentials", { host: "localhost:3004", origin: "http://user@localhost:8080" }],
    ["Origin path", { host: "localhost:3004", origin: "http://localhost:8080/path" }],
  ])("rejects %s", (_description, headers) => {
    expect(isTrustedLocalApiRequest({ headers }, { apiPort: 3004, webPort: 8080 })).toBe(false);
  });

  it("requires application/json for POST API requests only", () => {
    expect(isJsonApiRequest({
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
    }, "/api/ai/chat")).toBe(true);
    expect(isJsonApiRequest({
      method: "POST",
      headers: { "content-type": "text/plain" },
    }, "/api/ai/chat")).toBe(false);
    expect(isJsonApiRequest({ method: "POST", headers: {} }, "/api/ai/chat")).toBe(false);
    expect(isJsonApiRequest({ method: "GET", headers: {} }, "/health")).toBe(true);
    expect(isJsonApiRequest({ method: "POST", headers: {} }, "/upload")).toBe(true);
  });

  it("builds a least-privilege preflight response without a wildcard origin", () => {
    const headers = buildLocalCorsHeaders({
      headers: { origin: "http://localhost:8080" },
    }, { apiPort: 3004, webPort: 8080 });

    expect(headers).toEqual({
      "Access-Control-Allow-Origin": "http://localhost:8080",
      Vary: "Origin",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    expect(Object.values(headers)).not.toContain("*");
    expect(buildLocalCorsHeaders(
      { headers: {} },
      { apiPort: 3004, webPort: 8080 },
    )).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(buildLocalCorsHeaders(
      { headers: { origin: "https://attacker.example" } },
      { apiPort: 3004, webPort: 8080 },
    )).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("parses a JSON body that is within the configured byte limit", async () => {
    const request = requestBody(["{\"message\":", "\"ok\"}"], { "content-length": "16" });

    await expect(readBoundedJsonBody(request, { maxBytes: 16 })).resolves.toEqual({ message: "ok" });
  });

  it("rejects an oversized Content-Length with 413 before buffering", async () => {
    const request = requestBody(["{\"message\":\"too large\"}"], { "content-length": "25" });

    await expect(readBoundedJsonBody(request, { maxBytes: 16 })).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("rejects an oversized chunked body with 413", async () => {
    const request = requestBody(["{\"message\":", "\"too large\"}"]);

    await expect(readBoundedJsonBody(request, { maxBytes: 16 })).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("maps body-limit and malformed-JSON errors to safe client responses", async () => {
    let oversizedError;
    try {
      await readBoundedJsonBody(requestBody(["too large"]), { maxBytes: 3 });
    } catch (error) {
      oversizedError = error;
    }
    expect(toSafeLocalApiBodyResponse(oversizedError)).toEqual({
      statusCode: 413,
      payload: { success: false, error: "REQUEST_BODY_TOO_LARGE" },
    });

    let invalidJsonError;
    try {
      await readBoundedJsonBody(requestBody(["not-json"]), { maxBytes: 64 });
    } catch (error) {
      invalidJsonError = error;
    }
    expect(toSafeLocalApiBodyResponse(invalidJsonError)).toEqual({
      statusCode: 400,
      payload: { success: false, error: "INVALID_JSON_REQUEST_BODY" },
    });
    expect(toSafeLocalApiBodyResponse(new Error("private upstream failure"))).toBeNull();
  });
});
