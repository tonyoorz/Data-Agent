import { describe, expect, it } from "vitest";

import { createLocalHttpBoundary, resolveLocalListenHost } from "../../../server/localHttpBoundary.mjs";

describe("local HTTP boundary", () => {
  it("binds to loopback and admits an allowlisted local JSON request", () => {
    const boundary = createLocalHttpBoundary({});

    expect(resolveLocalListenHost({})).toBe("127.0.0.1");
    expect(boundary.evaluate({
      method: "POST",
      headers: {
        host: "127.0.0.1:3004",
        origin: "http://localhost:8080",
        "content-type": "application/json; charset=utf-8",
      },
    })).toEqual(expect.objectContaining({
      allowed: true,
      corsOrigin: "http://localhost:8080",
    }));
  });

  it("rejects non-loopback bind hosts, untrusted hosts and origins, and non-JSON POSTs", () => {
    expect(() => resolveLocalListenHost({ VIZION_API_HOST: "0.0.0.0" })).toThrow("VIZION_LISTEN_HOST_NOT_LOOPBACK");

    const boundary = createLocalHttpBoundary({});

    expect(boundary.evaluate({
      method: "GET",
      headers: { host: "evil.example" },
    })).toMatchObject({
      allowed: false,
      statusCode: 421,
      code: "HTTP_HOST_NOT_ALLOWED",
    });
    expect(boundary.evaluate({
      method: "GET",
      headers: {
        host: "localhost:3004",
        origin: "https://evil.example",
      },
    })).toMatchObject({
      allowed: false,
      statusCode: 403,
      code: "HTTP_ORIGIN_NOT_ALLOWED",
    });
    expect(boundary.evaluate({
      method: "POST",
      headers: {
        host: "localhost:3004",
        "content-type": "text/plain",
      },
    })).toMatchObject({
      allowed: false,
      statusCode: 415,
      code: "HTTP_JSON_CONTENT_TYPE_REQUIRED",
    });
  });
});