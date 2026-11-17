import { describe, expect, it, vi } from "vitest";
import { resolveChatModelConfig } from "../../../server/chatModelConfig.mjs";
import { parseModelJson } from "../../../server/modelJson.mjs";
import {
  generateTestCaseContent,
  resolveMaxGenerationRounds,
  runTestCaseGenerationPipeline,
} from "../../../server/testcaseGeneration.mjs";
import { resolveJudgeModel } from "../../../server/testCaseJudge.mjs";
import { computeModelCoverage, formatTestModelForPrompt, validateTestModel } from "../../../server/testModel.mjs";

// Loopback proxy base URL + mocked fetch — no network. Test-model stage off by default
// so legacy pipeline tests exercise the P0 single-stage path; model-stage tests enable it.
const ENV = { GLM_PROXY_API_KEY: "test-key", TESTCASE_TEST_MODEL: "0" };
const ENV_WITH_MODEL = { GLM_PROXY_API_KEY: "test-key" };

const DEFECT = {
  defect_id: "2804379",
  name: "pps constant CPU load when car is moving",
  severity: "Very High",
  software_version: "PU2707",
  assigned_ecu: "IDCEVO",
  lead_model: "G20",
  project: "SP25",
  description: "CPU load rises constantly while driving",
};

const PREPARED = {
  success: true,
  defect_info: DEFECT,
  similar_cases: [{ testId: "1414874", name: "pps CPU load regression", score: 0.83 }],
  few_shot_text: "reference few-shot",
  context_text: "Verified business scope: project SP25; release R-26-07.",
  bodies_fetched: 2,
};

const GOOD_STEPS = [
  "- [PreCon] IDCEvo test vehicle with PU2707 software",
  "- record CPU load of pps in each drive mode",
  "- compare candidate against baseline build",
  "- ? CPU load must NOT exceed 0.17% in IDLE-FAHREN mode",
].join("\n");

function modelReply(content) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function makeVerifyResult(passed) {
  return {
    success: true,
    verification: passed
      ? { passed: true, criteria: [{ name: "format_compliance", passed: true, evidence: "ok" }], feedback: "" }
      : {
          passed: false,
          criteria: [{ name: "failure_mode_coverage", passed: false, evidence: "missing pps terms" }],
          feedback: "Regeneration needed - failure_mode_coverage: steps miss the defect's failure mode",
        },
  };
}

function passJudge() {
  return {
    passed: true,
    criteria: [{ name: "grounding", passed: true, score: 0.9, evidence: "all thresholds traced" }],
    feedback: "",
  };
}

describe("parseModelJson", () => {
  it("parses fenced JSON", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("parses prose-wrapped JSON", () => {
    expect(parseModelJson('Here you go: {"a": 1} hope it helps')).toEqual({ a: 1 });
  });
  it("returns null for invalid content", () => {
    expect(parseModelJson("no json at all")).toBeNull();
    expect(parseModelJson('{"broken": ')).toBeNull();
  });
});

describe("resolveJudgeModel / resolveMaxGenerationRounds", () => {
  it("prefers the explicit env override", () => {
    expect(resolveJudgeModel("deepseek-v4-flash", { TESTCASE_JUDGE_MODEL: "glm-5" })).toBe("glm-5");
  });
  it("auto-selects a different model family than the generator", () => {
    expect(resolveJudgeModel("deepseek-v4-flash", ENV)).toBe("deepseek-v4-pro");
  });
  it("falls back to the generator model when only one is allowed", () => {
    expect(resolveJudgeModel("deepseek-v4-flash", { GLM_PROXY_API_KEY: "k", CHAT_MODEL_OPTIONS: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  });
  it("clamps rounds to 1..5 with default 3", () => {
    expect(resolveMaxGenerationRounds({})).toBe(3);
    expect(resolveMaxGenerationRounds({ TESTCASE_MAX_GENERATION_ROUNDS: "9" })).toBe(5);
    expect(resolveMaxGenerationRounds({ TESTCASE_MAX_GENERATION_ROUNDS: "0" })).toBe(1);
    expect(resolveMaxGenerationRounds({ TESTCASE_MAX_GENERATION_ROUNDS: "2" })).toBe(2);
  });
});

describe("generateTestCaseContent", () => {
  it("parses fenced JSON and applies the testName fallback", async () => {
    const chatConfig = resolveChatModelConfig(undefined, ENV);
    const fetchImpl = vi.fn(async () => modelReply('```json\n{"descriptionHtml":"<html></html>","stepsText":"- [PreCon] a\\n- ? b <= 1%"}\n```'));
    const result = await generateTestCaseContent({
      defectInfo: DEFECT,
      fewShotText: "reference-block",
      contextText: "Verified business scope: project SP25; release R-26-07.",
      chatConfig,
      env: ENV,
      fetchImpl,
    });
    expect(result.testName).toContain("D2804379");
    expect(result.stepsText).toContain("? b <= 1%");
    // Grounding context and few-shot text are injected into the prompt.
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const userContent = body.messages.find((m) => m.role === "user").content;
    expect(userContent).toContain("Verified business scope");
    expect(userContent).toContain("reference-block");
  });

  it("repairs invalid JSON with one retry", async () => {
    const chatConfig = resolveChatModelConfig(undefined, ENV);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(modelReply("sure, here is your test: {oops"))
      .mockResolvedValueOnce(modelReply('{"testName":"t","descriptionHtml":"h","stepsText":"s"}'));
    const result = await generateTestCaseContent({ defectInfo: DEFECT, chatConfig, env: ENV, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.testName).toBe("t");
    const repairBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(repairBody.messages.at(-1).content).toContain("valid JSON");
  });

  it("includes the previous draft and feedback on regeneration calls", async () => {
    const chatConfig = resolveChatModelConfig(undefined, ENV);
    const fetchImpl = vi.fn(async () => modelReply('{"testName":"t2","descriptionHtml":"h","stepsText":"s2"}'));
    await generateTestCaseContent({
      defectInfo: DEFECT,
      chatConfig,
      env: ENV,
      fetchImpl,
      previousAttempt: { testName: "t1", descriptionHtml: "h", stepsText: "s1" },
      feedback: "Regeneration needed - failure_mode_coverage",
    });
    const userContent = JSON.parse(fetchImpl.mock.calls[0][1].body).messages.find((m) => m.role === "user").content;
    expect(userContent).toContain("QUALITY FEEDBACK");
    expect(userContent).toContain("failure_mode_coverage");
    expect(userContent).toContain("s1");
  });
});

describe("runTestCaseGenerationPipeline", () => {
  function makeBridge({ verifySequence, prepare = PREPARED } = {}) {
    const state = { verifyCalls: 0, verifyPayloads: [] };
    const bridge = async (payload) => {
      if (payload.action === "prepare") return prepare;
      if (payload.action === "verify") {
        state.verifyPayloads.push(payload);
        const passed = verifySequence ? verifySequence[state.verifyCalls] : true;
        state.verifyCalls += 1;
        return makeVerifyResult(passed);
      }
      throw new Error(`unexpected action ${payload.action}`);
    };
    return { bridge, state };
  }

  function makeGenerate({ stepSequence }) {
    const state = { calls: [] };
    const generate = async (args) => {
      state.calls.push(args);
      const stepsText = stepSequence[Math.min(state.calls.length - 1, stepSequence.length - 1)];
      return { testName: `gen-${state.calls.length}`, descriptionHtml: "<html></html>", stepsText };
    };
    return { generate, state };
  }

  it("passes on the first round when heuristics and judge both pass", async () => {
    const { bridge } = makeBridge();
    const { generate, state } = makeGenerate({ stepSequence: [GOOD_STEPS] });
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV,
      generateFn: generate,
      judgeFn: passJudge,
    });
    expect(result.generationRounds).toBe(1);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ round: 1, heuristicPassed: true, judgePassed: true });
    expect(result.attempt.testName).toBe("gen-1");
    expect(result.contextUsed).toBe(true);
    expect(result.bodiesFetched).toBe(2);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].contextText).toContain("SP25");
  });

  it("regenerates with feedback until the heuristics pass", async () => {
    const { bridge, state: bridgeState } = makeBridge({ verifySequence: [false, true] });
    const { generate, state } = makeGenerate({ stepSequence: ["- vague", GOOD_STEPS] });
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV,
      generateFn: generate,
      judgeFn: passJudge,
    });
    expect(result.generationRounds).toBe(2);
    expect(result.attempt.stepsText).toBe(GOOD_STEPS);
    expect(bridgeState.verifyCalls).toBe(2);
    // The second generation carried the first round's feedback and previous draft.
    expect(state.calls[1].feedback).toContain("failure_mode_coverage");
    expect(state.calls[1].previousAttempt.stepsText).toBe("- vague");
    expect(result.history[0].failedCriteria).toContain("failure_mode_coverage");
    expect(result.history[1].heuristicPassed).toBe(true);
  });

  it("degrades to heuristic-only when the judge model fails", async () => {
    const { bridge } = makeBridge();
    const { generate } = makeGenerate({ stepSequence: [GOOD_STEPS] });
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV,
      generateFn: generate,
      judgeFn: async () => {
        throw new Error("judge endpoint down");
      },
    });
    expect(result.judge.skipped).toBe(true);
    expect(result.judge.reason).toContain("judge endpoint down");
    expect(result.generationRounds).toBe(1); // judge failure must not trigger useless regeneration
    expect(result.history[0].judgeSkipped).toBe(true);
    expect(result.history[0].judgePassed).toBeNull();
  });

  it("stops at the round cap and still returns the last attempt", async () => {
    const { bridge } = makeBridge({ verifySequence: [false, false, false, false] });
    const { generate } = makeGenerate({ stepSequence: ["- vague"] });
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV,
      generateFn: generate,
      judgeFn: passJudge,
    });
    expect(result.generationRounds).toBe(3);
    expect(result.history).toHaveLength(3);
    expect(result.attempt.testName).toBe("gen-3");
    expect(result.verification.passed).toBe(false);
  });

  it("fails fast when prepare fails", async () => {
    const bridge = async () => ({ success: false, error: "defect not found" });
    await expect(
      runTestCaseGenerationPipeline({ runTestCaseBridge: bridge, defectId: "999", env: ENV, generateFn: async () => ({}), judgeFn: passJudge }),
    ).rejects.toMatchObject({ code: "TESTCASE_PREPARE_FAILED", message: "defect not found" });
  });

  it("uses a judge model from a different family than the generator", async () => {
    const { bridge } = makeBridge();
    const seen = { generator: [], judge: [] };
    const { generate } = makeGenerate({ stepSequence: [GOOD_STEPS] });
    await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV,
      generateFn: async (args) => {
        seen.generator.push(args.chatConfig.model);
        return generate(args);
      },
      judgeFn: async ({ chatConfig }) => {
        seen.judge.push(chatConfig.model);
        return passJudge();
      },
    });
    expect(seen.generator.length).toBeGreaterThan(0);
    expect(seen.judge).toHaveLength(seen.generator.length);
    for (let i = 0; i < seen.judge.length; i += 1) {
      expect(seen.judge[i]).not.toBe(seen.generator[i]);
    }
  });
});

// --- stage-1 test design model ---

const TEST_MODEL = {
  dimensions: [
    {
      name: "drive_mode",
      aspect: "vehicle state",
      classes: [
        { id: "dm-1", name: "IDLE-FAHREN" },
        { id: "dm-2", name: "TYPICAL mode", isBoundary: true },
      ],
    },
    {
      name: "software_build",
      aspect: "candidate vs baseline",
      classes: [
        { id: "sw-1", name: "baseline build PU2707" },
        { id: "sw-2", name: "candidate build PU2708" },
      ],
    },
  ],
  combinations: [
    { id: "TC-1", classRefs: ["dm-1", "sw-2"], priority: "high", rationale: "defect scenario" },
    { id: "TC-2", classRefs: ["dm-2", "sw-1"], priority: "normal", rationale: "boundary contrast" },
  ],
};

const MODEL_STEPS = [
  "- [PreCon] IDCEvo test vehicle ready",
  "- drive in IDLE-FAHREN mode on candidate build PU2708 and record pps CPU load",
  "- drive in TYPICAL mode on baseline build PU2707 and record pps CPU load",
  "- compare candidate against baseline",
  "- ? CPU load must NOT exceed 0.17%",
].join("\n");

describe("validateTestModel", () => {
  it("accepts a well-formed model", () => {
    const model = validateTestModel(TEST_MODEL);
    expect(model).not.toBeNull();
    expect(model.dimensions).toHaveLength(2);
    expect(model.combinations.map((c) => c.id)).toEqual(["TC-1", "TC-2"]);
  });
  it("rejects classRefs that do not resolve", () => {
    const model = validateTestModel({
      dimensions: TEST_MODEL.dimensions,
      combinations: [{ id: "TC-1", classRefs: ["nope-1"] }],
    });
    expect(model).toBeNull();
  });
  it("rejects duplicate combination ids and empty combination lists", () => {
    expect(validateTestModel({
      dimensions: TEST_MODEL.dimensions,
      combinations: [
        { id: "TC-1", classRefs: ["dm-1"] },
        { id: "TC-1", classRefs: ["dm-2"] },
      ],
    })).toBeNull();
    expect(validateTestModel({ dimensions: TEST_MODEL.dimensions, combinations: [] })).toBeNull();
    expect(validateTestModel(null)).toBeNull();
  });
});

describe("formatTestModelForPrompt", () => {
  it("renders dimensions, boundaries, and combinations", () => {
    const text = formatTestModelForPrompt(TEST_MODEL);
    expect(text).toContain("Dimension drive_mode");
    expect(text).toContain("[boundary]");
    expect(text).toContain("TC-1");
    expect(text).toContain("IDLE-FAHREN + candidate build PU2708");
    expect(text).toContain("MUST cover every combination");
  });
});

describe("computeModelCoverage", () => {
  it("returns 100% when all combinations are claimed and keyword-verified", () => {
    const result = computeModelCoverage(TEST_MODEL, ["TC-1", "TC-2"], MODEL_STEPS);
    expect(result.coveragePct).toBe(100);
    expect(result.coveredIds).toEqual(["TC-1", "TC-2"]);
  });
  it("marks unclaimed combinations as uncovered", () => {
    const result = computeModelCoverage(TEST_MODEL, ["TC-1"], MODEL_STEPS);
    expect(result.coveragePct).toBe(50);
    expect(result.uncoveredIds).toEqual(["TC-2"]);
  });
  it("rejects claimed combinations whose class terms are missing from the steps", () => {
    const stepsWithoutCandidate = MODEL_STEPS.replace("candidate build PU2708", "another build");
    const result = computeModelCoverage(TEST_MODEL, ["TC-1", "TC-2"], stepsWithoutCandidate);
    expect(result.uncoveredIds).toContain("TC-1");
    expect(result.coveragePct).toBe(50);
  });
  it("returns null without a model", () => {
    expect(computeModelCoverage(null, ["TC-1"], MODEL_STEPS)).toBeNull();
  });
});

describe("runTestCaseGenerationPipeline with test design model", () => {
  function makeModelVerify(state) {
    const bridge = async (payload) => {
      if (payload.action === "prepare") return PREPARED;
      if (payload.action === "verify") {
        state.verifyPayloads.push(payload);
        // Mirrors the Python verifier: model_coverage only applies when a model exists.
        const modelOk = !payload.test_model
          || (Array.isArray(payload.combination_coverage)
            && payload.test_model.combinations.every((combo) => payload.combination_coverage.includes(combo.id)));
        return {
          success: true,
          verification: modelOk
            ? { passed: true, criteria: [{ name: "model_coverage", passed: true, evidence: "all combinations covered" }], feedback: "" }
            : {
                passed: false,
                criteria: [{ name: "model_coverage", passed: false, evidence: "uncovered combinations" }],
                feedback: "Regeneration needed - model_coverage: cover every combination from the test design model",
              },
        };
      }
      throw new Error(`unexpected action ${payload.action}`);
    };
    return { bridge, state };
  }

  it("builds the model once, injects it into generation and verification, reports coverage", async () => {
    const { bridge, state } = makeModelVerify({ verifyPayloads: [] });
    const buildModelFn = vi.fn(async () => TEST_MODEL);
    const generateCalls = [];
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV_WITH_MODEL,
      buildModelFn,
      judgeFn: passJudge,
      generateFn: async (args) => {
        generateCalls.push(args);
        return {
          testName: "model-gen",
          descriptionHtml: "<html></html>",
          stepsText: MODEL_STEPS,
          combinationCoverage: ["TC-1", "TC-2"],
        };
      },
    });

    expect(buildModelFn).toHaveBeenCalledTimes(1);
    expect(generateCalls[0].testModelText).toContain("Test design model");
    expect(generateCalls[0].testModelText).toContain("TC-1");
    expect(state.verifyPayloads[0].test_model).toEqual(TEST_MODEL);
    expect(state.verifyPayloads[0].combination_coverage).toEqual(["TC-1", "TC-2"]);
    expect(result.generationRounds).toBe(1);
    expect(result.testModel).toEqual(TEST_MODEL);
    expect(result.modelCoveragePct).toBe(100);
  });

  it("regenerates when combinations are not covered and reports the final coverage", async () => {
    const { bridge } = makeModelVerify({ verifyPayloads: [] });
    const generateCalls = [];
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV_WITH_MODEL,
      buildModelFn: async () => TEST_MODEL,
      judgeFn: passJudge,
      generateFn: async (args) => {
        generateCalls.push(args);
        const covered = generateCalls.length === 1 ? [] : ["TC-1", "TC-2"];
        return {
          testName: `gen-${generateCalls.length}`,
          descriptionHtml: "<html></html>",
          stepsText: MODEL_STEPS,
          combinationCoverage: covered,
        };
      },
    });

    expect(result.generationRounds).toBe(2);
    expect(generateCalls[1].feedback).toContain("model_coverage");
    expect(result.modelCoveragePct).toBe(100);
  });

  it("degrades to single-stage when the model build fails", async () => {
    const { bridge } = makeModelVerify({ verifyPayloads: [] });
    const generateCalls = [];
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: ENV_WITH_MODEL,
      buildModelFn: async () => {
        throw new Error("model LLM down");
      },
      judgeFn: passJudge,
      generateFn: async (args) => {
        generateCalls.push(args);
        return { testName: "fallback", descriptionHtml: "<html></html>", stepsText: GOOD_STEPS, combinationCoverage: [] };
      },
    });

    expect(result.testModel).toBeNull();
    expect(result.modelCoveragePct).toBeNull();
    expect(generateCalls[0].testModelText).toBe("");
    // No test_model in the verify payload → single-stage verification contract.
    expect("test_model" in bridge ? true : false).toBe(false);
    expect(result.generationRounds).toBe(1);
  });

  it("honors an explicit maxRounds override below the env budget", async () => {
    const { bridge } = makeModelVerify({ verifyPayloads: [] });
    const generateCalls = [];
    const result = await runTestCaseGenerationPipeline({
      runTestCaseBridge: bridge,
      defectId: "2804379",
      env: { ...ENV, TESTCASE_MAX_GENERATION_ROUNDS: "3" },
      buildModelFn: async () => TEST_MODEL,
      judgeFn: passJudge,
      maxRounds: 1,
      generateFn: async () => {
        generateCalls.push(1);
        return { testName: "only", descriptionHtml: "<html></html>", stepsText: "vague", combinationCoverage: [] };
      },
    });
    expect(generateCalls).toHaveLength(1);
    expect(result.generationRounds).toBe(1);
  });
});
