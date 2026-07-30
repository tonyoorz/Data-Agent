import { describe, expect, it } from "vitest";

import { resolveRequestUrl } from "../../../server/httpRequestUrl.mjs";

describe("resolveRequestUrl", () => {
  it("parses normal request paths", () => {
    const url = resolveRequestUrl("/health?probe=1", "localhost:3004");

    expect(url.pathname).toBe("/health");
    expect(url.searchParams.get("probe")).toBe("1");
    expect(url.host).toBe("localhost:3004");
  });

  it("normalizes slash-only malformed request targets", () => {
    const url = resolveRequestUrl("//", "127.0.0.1:3004");

    expect(url.pathname).toBe("/");
  });

  it("normalizes duplicated leading slashes as local paths", () => {
    const url = resolveRequestUrl("///api/ai/chat", "127.0.0.1:3004");

    expect(url.pathname).toBe("/api/ai/chat");
  });

  it("falls back to a safe host when Host is malformed", () => {
    const url = resolveRequestUrl("/health", "bad host value");

    expect(url.href).toBe("http://127.0.0.1/health");
  });
});