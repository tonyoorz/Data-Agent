// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildAnalyticsProxyUrl,
  resolveAnalyticsApiBase,
  resolveAnalyticsProxyTimeoutMs,
} from "../../../server/analyticsApiConfig.mjs";

describe("analytics API configuration", () => {
  it("uses the loopback analytics service by default", () => {
    expect(resolveAnalyticsApiBase({})).toBe("http://127.0.0.1:3003");
  });

  it("uses the configured local analytics port when no explicit base is set", () => {
    expect(resolveAnalyticsApiBase({ VIZION_ANALYTICS_PORT: "8103" })).toBe("http://127.0.0.1:8103");
  });

  it("builds proxy URLs from the configured private upstream", () => {
    const searchParams = new URLSearchParams();
    searchParams.append("run", "weekly");
    searchParams.append("team", "DTSV China");

    expect(buildAnalyticsProxyUrl(
      "/api/qgate-reports/weekly-report",
      searchParams,
      "https://analytics.internal:8103",
    ).toString()).toBe(
      "https://analytics.internal:8103/api/qgate-reports/weekly-report?run=weekly&team=DTSV+China",
    );
  });

  it.each([
    "file:///tmp/analytics",
    "http://user:secret@analytics.internal:8103",
    "http://analytics.internal:8103/base-path",
    "http://analytics.internal:8103?token=secret",
    "http://analytics.internal:8103",
    "not-a-url",
  ])("rejects unsafe or ambiguous upstream bases: %s", (configured) => {
    expect(() => resolveAnalyticsApiBase({
      VIZION_ANALYTICS_API_BASE: configured,
    })).toThrow("VIZION_ANALYTICS_API_BASE_INVALID");
  });

  it.each(["0", "65536", "not-a-port"])('rejects invalid analytics ports: %s', (configuredPort) => {
    expect(() => resolveAnalyticsApiBase({
      VIZION_ANALYTICS_PORT: configuredPort,
    })).toThrow("VIZION_ANALYTICS_API_BASE_INVALID");
  });

  it.each(["0", "120001", "not-a-timeout"])('rejects invalid proxy timeouts: %s', (configuredTimeout) => {
    expect(() => resolveAnalyticsProxyTimeoutMs({
      VIZION_ANALYTICS_PROXY_TIMEOUT_MS: configuredTimeout,
    })).toThrow("VIZION_ANALYTICS_PROXY_TIMEOUT_INVALID");
  });

  it.each(["//attacker.example/report", "report/weekly"])('rejects proxy path escapes: %s', (pathname) => {
    expect(() => buildAnalyticsProxyUrl(
      pathname,
      new URLSearchParams(),
      "https://analytics.internal:8103",
    )).toThrow("ANALYTICS_PROXY_PATH_INVALID");
  });
});
