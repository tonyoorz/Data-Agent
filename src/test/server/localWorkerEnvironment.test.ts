import { describe, expect, it } from "vitest";

import { resolveLocalWorkerEnvironment } from "../../../server/localWorkerEnvironment.mjs";

describe("local Python worker environment", () => {
  it("keeps runtime/model-cache settings while excluding unrelated service secrets", () => {
    const workerEnv = resolveLocalWorkerEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CUDA_VISIBLE_DEVICES: "0",
      DUPSEARCH_LOCAL_ASR_FFMPEG: "/usr/bin/ffmpeg",
      DUPSEARCH_CHAT_API_KEY: "model-secret",
      VIZION_AGENT_ACTOR_CAPABILITY_SECRET: "capability-secret",
      VIZION_OIDC_ISSUER: "https://issuer.example.test",
      PYTHONHOME: "/unsafe/python-home",
      PYTHONPATH: "/unsafe/python-path",
    });

    expect(workerEnv).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CUDA_VISIBLE_DEVICES: "0",
      DUPSEARCH_LOCAL_ASR_FFMPEG: "/usr/bin/ffmpeg",
      PYTHONIOENCODING: "utf-8",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    });
    expect(workerEnv).not.toHaveProperty("DUPSEARCH_CHAT_API_KEY");
    expect(workerEnv).not.toHaveProperty("VIZION_AGENT_ACTOR_CAPABILITY_SECRET");
    expect(workerEnv).not.toHaveProperty("VIZION_OIDC_ISSUER");
    expect(workerEnv).not.toHaveProperty("PYTHONHOME");
    expect(workerEnv).not.toHaveProperty("PYTHONPATH");
  });
});
