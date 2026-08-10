// @vitest-environment node
import { describe, expect, it } from "vitest";

import viteConfig from "../../vite.config";

describe("Vite dependency optimization", () => {
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
});