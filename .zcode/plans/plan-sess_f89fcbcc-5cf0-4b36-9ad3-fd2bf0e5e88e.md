# P1 升级：两段式测试模型生成 + 治理/审计集成

在 P0 闭环之上实现两件事：**(A) 两段式生成**——先产出机器可校验的"测试设计模型"（维度/等价类/边界 + 选定组合），再展开成用例，组合覆盖率成为可计算、可审计的数字；**(B) 治理集成**——每次生成写入 run-summary 审计、scorecard 新增 testcase 质量指标、注册 `create_testcase` agent 工具（聊天内可触发，永不自动写 Octane）。

## A. 两段式测试模型（server/testModel.mjs 新模块）

1. **Stage 1 — `buildTestModel({defectInfo, contextText, fewShotText, chatConfig, env, fetchImpl})`**：一次 LLM 调用产出 JSON 测试模型：
   `{"dimensions":[{"name","aspect","classes":[{"id","name","isBoundary?"}]}], "combinations":[{"id","classRefs":[...],"priority","rationale"}]}`
   等价类划分 + 边界值 + 组合选择（维度多时倾向 pairwise，由 rationale 说明取舍）。
2. **`validateTestModel(model)`** 程序化校验：形状、id 唯一、classRefs 全部可解析、组合数 ≥1、维度 ≥1；不合规 → 返回 null（降级为现有单段生成，不阻断）。
3. **`formatTestModelForPrompt(model)`**：紧凑文本，注入 Stage 2 生成 prompt，指令要求"覆盖全部列出的组合，每个 checkpoint 至少对应一个组合"；生成输出 JSON 新增字段 `combinationCoverage: ["TC-1",...]`。
4. **`computeModelCoverage(model, claimedCoverage, stepsText)`**：可信覆盖计算——声明的组合 id 必须存在，且对该组合引用的每个类做关键词交叉验证（类名归一化后须在 stepsText 中出现），防止空口自报；返回 `{coveredIds, uncoveredIds, coveragePct}`。
5. 开关：`TESTCASE_TEST_MODEL`（默认开）。模型构建失败/关闭 → `testModel: null`，行为与 P0 完全一致。

## B1. 覆盖校验进验证器（Python 侧保持统一）

- `scripts/testcase_bridge.py` `_do_verify` payload 新增 `test_model`、`combination_coverage`；`backend/analytics/test_case_verifier.py` 新增第 6 条准则 **`model_coverage`**（仅当 test_model 存在时加入准则列表）：全部组合覆盖且关键词交叉验证通过才 pass，evidence 列出未覆盖组合 → 自动进入现有 CRAG 反馈回路（无需改回路代码）。
- judge prompt（testCaseJudge.mjs）追加"测试设计模型（权威组合清单）"块，强化 grounding/completeness 判定。

## C. UI 展示

- `testCaseTypes.ts`：新增 `TestModel`/`TestModelDimension`/`TestModelCombination` 接口；`TestCaseResult` 增加 `testModel?`、`modelCoveragePct?`。
- `TestCasePreviewCard.tsx`：新章节"测试设计模型"——维度+等价类 chips（边界类高亮）、选定组合数、覆盖徽标（x/y 组合覆盖，百分比）。

## D. 治理集成

1. **run-summary 审计**（斜杠命令路径）：`/api/create-testcase` 端点完成后调用现有 `runtimeStore.appendRunSummary`；新增 `buildTestCaseRunSummary`（放 `server/runSummary.mjs`）：`intent: "create_testcase"`、`outcome: completed|failed`、`failureCode`；质量字段 `generationRounds`、`verificationPassed`、`judgeStatus`（pass|fail|skipped）、`modelCoveragePct`。
2. **`minimalRunSummary` 白名单扩展**（`runtimeAuditStore.mjs`）+ 空值省略，保证新字段能落盘。
3. **scorecard**（`evals/scorecard/metrics.mjs` + `runScorecard.mjs`）：新指标 `testcase_quality`——从 intent=create_testcase 行聚合：生成数、平均轮次、启发式通过率、judge 通过率、平均组合覆盖率；runtime markdown 表新增一列渲染。
4. **agent 工具 `create_testcase`**：
   - `MAIN_AGENT_TOOLS` 新增定义（args: `{defect_id: string}` required），描述明确"生成预览，绝不自动写入 Octane，提交需用户在预览卡确认"；
   - 执行器 `executeGenerateTestCase(toolCall, {runTestCaseBridge})` 直接调 `runTestCaseGenerationPipeline`（依赖注入，仿 `runDuplicateBridge` 模式，不走 HTTP 回环），`contextText` 输出紧凑结果块 + 提示用斜杠命令获取完整预览卡；
   - 同步 5 处登记：`mainAgentToolsets.mjs` 的 `testcase_context` 工具集、`mainAgentToolRegistry.mjs` 副本、`runSummary.mjs` SAFE_TOOL_NAMES、`mainAgentToolDataBoundary.mjs`（分类 **internal_only**，与端点 internal-actor 鉴权姿态一致）、`mainAgentToolPlanning.mjs` 策略行（先 get_test_case_context 取上下文，用户明确要求生成时才调 create_testcase）；
   - intent 复用现有 `testcase_context`（路由正则已命中），不新增 intent → 不动 golden 意图全集；新增 golden 用例 agent-012（"帮我基于缺陷 2804379 生成回归测试用例" → intent testcase_context，toolNamesInclude 含 create_testcase + get_test_case_context），离线回放自动覆盖。
   - `index.mjs`：toolDependencies 注入 `runTestCaseBridge`。

## 测试

- Node 扩展 `testcaseGeneration.test.ts`：模型构建/校验/降级、prompt 注入模型文本、组合覆盖计算（含关键词交叉验证拒假）、model_coverage 失败进反馈、`TESTCASE_TEST_MODEL=0` 旁路。
- 新增 `src/test/server/testcaseAgentTool.test.ts`：executeMainAgentToolCall 注入 mock bridge → toolMessage/contextText 形状；数据边界分类断言。
- 新增 `src/test/server/scorecardMetrics.test.ts`：computeRuntimeMetrics 对含 create_testcase 行的聚合正确性。
- Python：`test_test_case_rag.py` 增 model_coverage 准则用例（通过/未覆盖/关键词不符三种）；`test_testcase_bridge.py` 增 _do_verify 透传用例。
- 回归：全部现有 Python/Node 测试保持绿；`npm run eval:scorecard` 通过。

## 明确不做（P2）

- checkpoint 结构化 + 历史数据回放差分过滤（"基线 PASS/缺陷数据 FAIL"）；金标集人工标注；嵌入索引正文重构建。

## 验收标准

1. 一次生成产出可见的测试设计模型 + 组合覆盖率，未全覆盖时自动再生成并在预览卡显示；
2. `logs/agent-runtime/run-summaries.jsonl` 出现 create_testcase 行且带质量字段；`npm run eval:scorecard` 输出 testcase_quality 指标；
3. 聊天中说"基于缺陷 X 生成测试用例"时 agent 调用 create_test_case_context + create_testcase 工具（golden agent-012 通过），且不会写 Octane；
4. 全部测试绿。