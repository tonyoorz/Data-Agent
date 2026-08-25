// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("application HTML entry", () => {
  it("contains exactly one document, React root, and module entry", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(html.match(/<html\b/gi)).toHaveLength(1);
    expect(html.match(/<div id="root"><\/div>/g)).toHaveLength(1);
    expect(html.match(/src="\/src\/main\.tsx"/g)).toHaveLength(1);
  });
});
