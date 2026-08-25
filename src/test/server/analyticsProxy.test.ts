// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { proxyAnalyticsJson } from "../../../server/analyticsProxy.mjs";

function createResponse() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

describe("analytics JSON proxy", () => {
  it("uses only the configured upstream and preserves repeated query parameters", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: true }),
      {
        status: 206,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    ));
    const response = createResponse();
    const searchParams = new URLSearchParams();
    searchParams.append("team", "DTSV_China");
    searchParams.append("team", "Other");

    await proxyAnalyticsJson({
      pathname: "/api/qgate-reports/weekly-report",
      searchParams,
      response,
      analyticsApiBase: "https://analytics.internal:8103",
      fetchImpl,
      timeoutSignal: () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0].toString()).toBe(
      "https://analytics.internal:8103/api/qgate-reports/weekly-report?team=DTSV_China&team=Other",
    );
    expect(fetchImpl.mock.calls[0][0].origin).not.toBe("http://127.0.0.1:3003");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(response.writeHead).toHaveBeenCalledWith(206, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it("maps upstream connection failures to a stable 502 response", async () => {
    const response = createResponse();

    await proxyAnalyticsJson({
      pathname: "/api/qgate-reports/weekly-report",
      searchParams: new URLSearchParams(),
      response,
      analyticsApiBase: "https://analytics.internal:8103",
      fetchImpl: vi.fn(async () => { throw new Error("private upstream details"); }),
      timeoutSignal: () => undefined,
    });

    expect(response.writeHead).toHaveBeenCalledWith(502, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({
      success: false,
      error: "ANALYTICS_UPSTREAM_UNAVAILABLE",
    }));
  });

  it("maps an interrupted upstream body to the same stable 502 response", async () => {
    const response = createResponse();

    await proxyAnalyticsJson({
      pathname: "/api/qgate-reports/weekly-report",
      searchParams: new URLSearchParams(),
      response,
      analyticsApiBase: "https://analytics.internal:8103",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => { throw new Error("body aborted"); },
      })),
      timeoutSignal: () => undefined,
    });

    expect(response.writeHead).toHaveBeenCalledWith(502, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({
      success: false,
      error: "ANALYTICS_UPSTREAM_UNAVAILABLE",
    }));
  });

  it("maps the bounded upstream timeout to a stable 504 response", async () => {
    const response = createResponse();
    const signal = { smoke: "timeout-signal" };
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });

    await proxyAnalyticsJson({
      pathname: "/api/qgate-reports/weekly-report",
      searchParams: new URLSearchParams(),
      response,
      analyticsApiBase: "https://analytics.internal:8103",
      timeoutMs: 2500,
      fetchImpl,
      timeoutSignal: () => signal,
    });

    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), { redirect: "error", signal });
    expect(response.writeHead).toHaveBeenCalledWith(504, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({
      success: false,
      error: "ANALYTICS_UPSTREAM_TIMEOUT",
    }));
  });

  it("does not read or expose an upstream HTTP error body", async () => {
    const response = createResponse();
    const text = vi.fn(async () => "sqlite path=/srv/private/data.db stack=private");
    const cancel = vi.fn(async () => undefined);

    await proxyAnalyticsJson({
      pathname: "/api/qgate-reports/weekly-report",
      searchParams: new URLSearchParams(),
      response,
      analyticsApiBase: "https://analytics.internal:8103",
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 500,
        headers: new Headers({ "content-type": "text/plain" }),
        body: { cancel },
        text,
      })),
      timeoutSignal: () => undefined,
    });

    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({
      success: false,
      error: "ANALYTICS_UPSTREAM_REJECTED",
    }));
    expect(response.end.mock.calls.flat().join(" ")).not.toContain("/srv/private");
  });
});
