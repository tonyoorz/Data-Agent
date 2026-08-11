// @vitest-environment node
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import viteConfig from "../../vite.config";

describe("Vite dependency optimization", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("scans only the application HTML entry", () => {
    const config = viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.optimizeDeps?.entries).toEqual(["index.html"]);
  });

  it("ignores the local Python environment from file watching", () => {
    const config = viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.server?.watch).toMatchObject({
      ignored: expect.arrayContaining(["**/.venv/**"]),
    });
  });

  it("binds the trusted local development server to loopback only", () => {
    const config = viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.server?.host).toBe("127.0.0.1");
    expect(config.server?.allowedHosts).toBeUndefined();
  });

  it("uses configured service endpoints for local proxies", () => {
    vi.stubEnv("VIZION_ANALYTICS_API_BASE", "https://analytics.internal:8103");
    vi.stubEnv("VIZION_API_PORT", "8104");
    vi.stubEnv("VIZION_WEB_PORT", "8180");

    const config = viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.server?.port).toBe(8180);
    expect(config.server?.proxy?.["/api/full-picture"]).toMatchObject({
      target: "https://analytics.internal:8103",
    });
    expect(config.server?.proxy?.["/api"]).toMatchObject({
      target: "http://127.0.0.1:8104",
    });
  });

  it("loads non-client service settings through the Vite environment lifecycle", () => {
    const source = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");

    expect(source).toContain('"VIZION_ANALYTICS_API_BASE"');
    expect(source).toContain('"VIZION_API_PORT"');
    expect(source).not.toContain('loadEnv(mode, process.cwd(), "")');
  });
});
