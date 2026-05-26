import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDuplicateWarmupManager } from "../../../server/duplicateWarmup.mjs";

describe("createDuplicateWarmupManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("deduplicates concurrent warmup requests and exposes warm status", async () => {
    let resolveWarmup: ((value: unknown) => void) | null = null;
    const runDuplicateBridge = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWarmup = resolve;
        }),
    );

    const manager = createDuplicateWarmupManager({ runDuplicateBridge });

    const first = manager.ensureWarm({ reason: "startup" });
    const second = manager.ensureWarm({ reason: "duplicate-tab" });

    expect(manager.getStatus()).toEqual(
      expect.objectContaining({
        state: "warming",
      }),
    );
    expect(runDuplicateBridge).toHaveBeenCalledTimes(1);
    expect(runDuplicateBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "warmup",
      }),
    );

    resolveWarmup?.({
      success: true,
      result: {
        dataset_size: 34717,
        timings: {
          total_ms: 12450.5,
          load_defect_df_ms: 512.3,
          get_or_build_index_ms: 11912.7,
          index_cache_hit: false,
          index_rebuilt: true,
        },
      },
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(manager.getStatus()).toEqual(
      expect.objectContaining({
        state: "warm",
        lastReason: "startup",
        result: expect.objectContaining({
          dataset_size: 34717,
        }),
      }),
    );
  });
});