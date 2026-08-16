// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deriveOfflineVsOnline, readOfflineBaseline } from "../../../server/agentRuntime/evalMetrics.mjs";

describe("offline vs online divergence", () => {
  it("no divergence when offline == online", () => {
    const r = deriveOfflineVsOnline({
      offline: { accuracy: 0.9, n: 50 },
      online: { successRate: 0.9, n: 120 },
    });
    expect(r.offline).toEqual({ accuracy: 0.9, n: 50 });
    expect(r.online).toEqual({ successRate: 0.9, n: 120 });
    expect(r.divergencePp).toBe(0);
    expect(r.drift).toBe(false);
  });

  it("offline above online beyond threshold → drift flagged", () => {
    const r = deriveOfflineVsOnline({
      offline: { accuracy: 0.9, n: 50 },
      online: { successRate: 0.7, n: 120 },
    });
    expect(r.divergencePp).toBeCloseTo(20, 5);
    expect(r.drift).toBe(true);
    expect(r.note).toContain("线上分布漂移");
  });

  it("offline above online within threshold → no drift", () => {
    const r = deriveOfflineVsOnline({
      offline: { accuracy: 0.9, n: 50 },
      online: { successRate: 0.78, n: 120 },
    });
    expect(r.divergencePp).toBeCloseTo(12, 5);
    expect(r.drift).toBe(false);
  });

  it("online above offline → negative divergence, never drift", () => {
    const r = deriveOfflineVsOnline({
      offline: { accuracy: 0.6, n: 50 },
      online: { successRate: 0.9, n: 120 },
    });
    expect(r.divergencePp).toBeCloseTo(-30, 5);
    expect(r.drift).toBe(false);
  });

  it("insufficient online samples (n < minOnlineTurns) → unknown, not drift", () => {
    const r = deriveOfflineVsOnline({
      offline: { accuracy: 0.9, n: 50 },
      online: { successRate: 0.5, n: 3 },
    });
    expect(r.drift).toBe(false);
    expect(r.note).toContain("样本不足");
  });

  it("missing offline baseline → unavailable, not crash", () => {
    const r = deriveOfflineVsOnline({ offline: null, online: { successRate: 0.8, n: 50 } });
    expect(r.offline).toBeNull();
    expect(r.drift).toBe(false);
    expect(r.note).toContain("无离线基线");
  });

  it("readOfflineBaseline parses the stored baseline json", () => {
    const b = readOfflineBaseline();
    expect(b).toBeTruthy();
    expect(typeof b.accuracy).toBe("number");
    expect(typeof b.passed).toBe("number");
    expect(b.total).toBeGreaterThanOrEqual(50);
  });
});
