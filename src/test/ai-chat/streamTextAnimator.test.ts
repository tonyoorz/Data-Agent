import { afterEach, describe, expect, it, vi } from "vitest";

import { createStreamTextAnimator } from "@/components/dashboard/chat/streamTextAnimator";

describe("createStreamTextAnimator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals a pushed text progressively instead of emitting the full string at once", async () => {
    vi.useFakeTimers();

    const updates: string[] = [];
    const animator = createStreamTextAnimator({
      onUpdate: (nextText) => updates.push(nextText),
      intervalMs: 10,
      charsPerTick: 1,
    });

    animator.push("逐字流式");

    expect(updates).toEqual([]);

    await vi.advanceTimersByTimeAsync(10);
    expect(updates.at(-1)).toBe("逐");

    await vi.advanceTimersByTimeAsync(20);
    expect(updates.at(-1)).toBe("逐字流");
    expect(updates).not.toContain("逐字流式");

    const done = animator.finish();
    await vi.advanceTimersByTimeAsync(10);
    await done;

    expect(updates.at(-1)).toBe("逐字流式");
  });
});