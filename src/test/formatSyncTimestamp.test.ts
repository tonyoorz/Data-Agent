import { describe, expect, it } from "vitest";

import { formatSyncTimestamp } from "@/lib/formatSyncTimestamp";

describe("formatSyncTimestamp", () => {
  it("keeps plain dates unchanged", () => {
    expect(formatSyncTimestamp("2026-04-05")).toBe("2026-04-05");
  });

  it("converts ISO timestamps to Beijing time with second precision", () => {
    expect(formatSyncTimestamp("2026-06-01T09:08:26.907250+00:00")).toBe("2026-06-01 17:08:26");
  });

  it("returns null for empty values", () => {
    expect(formatSyncTimestamp(null)).toBeNull();
    expect(formatSyncTimestamp("   ")).toBeNull();
  });

  it("falls back to the raw value when parsing fails", () => {
    expect(formatSyncTimestamp("unknown")).toBe("unknown");
  });
});