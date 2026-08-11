// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createBoundedAnalyticsFetch } from "../../../server/boundedAnalyticsFetch.mjs";

describe("bounded analytics fetch", () => {
  it("adds a finite timeout signal to analytics requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const signal = { kind: "bounded" };
    const analyticsFetch = createBoundedAnalyticsFetch({
      fetchImpl,
      timeoutMs: 2500,
      timeoutSignal: (timeoutMs) => ({ ...signal, timeoutMs }),
    });

    await analyticsFetch("https://analytics.internal/api/semantic/query", {
      method: "POST",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://analytics.internal/api/semantic/query",
      {
        method: "POST",
        redirect: "error",
        signal: { ...signal, timeoutMs: 2500 },
      },
    );
  });

  it("preserves an explicit caller cancellation signal", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const callerSignal = { kind: "caller" };
    const timeoutSignal = vi.fn();
    const analyticsFetch = createBoundedAnalyticsFetch({ fetchImpl, timeoutSignal });

    await analyticsFetch("https://analytics.internal/api/semantic/query", {
      signal: callerSignal,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://analytics.internal/api/semantic/query",
      { redirect: "error", signal: callerSignal },
    );
    expect(timeoutSignal).not.toHaveBeenCalled();
  });
});
