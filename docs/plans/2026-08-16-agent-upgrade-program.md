# Data-Agent 升级计划：行业对标差距收口（P0/P1/P2）

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.
> **执行协议：** 每个任务完成后勾选 `[x]`。任何时间点可让 Agent 运行 `Review 进度`（见文末）检查未完成项并继续执行。每个任务独立可回溯、可重跑。

**Goal:** 基于 2026-08-16 行业对标（Palantir Foundry/AIP、Databricks Genie、Snowflake Cortex Analyst、ThoughtSpot、开源 NL2SQL/学术 SOTA）的差距清单，把 Data-Agent 升级到行业先进水平：离线评估体系、多路径生成+投票、Ontology 操作层（Action 写回+审计）、信任原语（Verified Answers/假设透明化）、MCP 生态开放。

**Architecture:** 三层推进——P0 打地基（评估闭环+生成质量），P1 补深度（Ontology kinetic 层+信任原语），P2 开生态（MCP/OSI）。所有新能力沿用现有治理边界：原语工具白名单、actor scope、approvalFlow、evidence 契约不放松。

**Tech Stack:** Node ESM (server/) + vitest（测试都在 `src/test/server/`）+ FastAPI analytics :3003 + SQLite。

**对标来源（2026-08-16 调研）：**
- Palantir：Ontology 语义+操作双角色、Action Type 事务写回、submission criteria、Action Log 审计、Ontology-as-code (SuperRepo)、OMCP、AIP Evals
- Databricks Genie：Trusted assets / Verified answer、Benchmarks（500 题+LLM judge+防冲突）、反馈闭环产品化
- Snowflake Cortex Analyst：多 agent 流水线（分类→特征→上下文→多模型生成→编译器纠错→合成）、Semantic Views、evaluations 防泄漏设计、90%+ 准确率
- Amazon Quick：Explanation（假设透明化 UI）
- 开源/学术：CHASE-SQL 多路径、MAC-SQL、execution-guided voting、BIRD/Spider 2.0、Vanna RAG、WrenAI MDL、SuperSonic headless BI

**差距基线（代码级，2026-08-15 @ c839dae4 审计）：**

| # | 差距 | 我方现状（代码事实） | 行业标准 |
|---|------|---------------------|---------|
| G1 | 离线 eval set | 无（只有单测+golden 内嵌断言） | Genie 500 题基准；Cortex evals accuracy/regression/latency |
| G2 | 评估防泄漏 | 无此概念 | Cortex: 评估时移除命中项防背题 |
| G3 | schema linking | resolver.mjs 仅 CJK 2-gram+别名（无向量） | 全员 embedding 检索 |
| G4 | 多路径生成 | 单路径计划（旧 Python 版有 CHASE-SQL 3 路径，Node 版未迁移） | CHASE-SQL/MAC-SQL 多候选+执行投票 |
| G5 | 执行验证投票 | 无 | execution-guided decoding + self-consistency |
| G6 | Ontology Action 层 | 只读 ontology（actions:3 是占位） | Palantir Action Type 事务写回+副作用 |
| G7 | 提交准则 | approvalFlow 只按 kind 审批，无业务条件 | Palantir submission criteria（用户/组/上下文条件） |
| G8 | 审计日志 | sessionEventLog（会话级） | Palantir Action Log 对象化审计（谁/何时/改了什么/版本） |
| G9 | Ontology-as-code | driftReconciler 有 diff/CLI，无 git round-trip | Palantir SuperRepo/Ontology-as-code |
| G10 | Verified answers | 无（semanticCache 只缓存结果） | Genie trusted assets / PBI verified answers / Cortex verified queries |
| G11 | 语义缓存相似度 | Jaccard bigram（feedbackAndCache.mjs:39-49） | 向量/TF-IDF 混合 |
| G12 | 假设透明化 | resolver 消歧结果埋在日志 | Amazon Quick Explanation 面板 |
| G13 | MCP 开放 | 无 | Palantir OMCP 2026-01；Tableau headless MCP |
| G14 | 语义互操作 | 私有 schema | Open Semantic Interchange (Tableau+Snowflake+dbt) |

---

## 任务索引（进度追踪）

- [x] **P0-A1** 评估数据集 schema + 50 题种子集
- [x] **P0-A2** 离线 eval runner（无 LLM 模式）
- [x] **P0-A3** 防泄漏机制
- [x] **P0-A4** 回归命令 + 趋势基线
- [x] **P0-A5** 线上线下打通
- [x] **P0-B1** SchemaLinker（embedding 可插拔）
- [x] **P0-B2** 多路径查询计划（CHASE-SQL 迁移）
- [x] **P0-B3** 执行投票
- [x] **P0-B4** 自纠错环增强
- [ ] **P1-C1** Action Type schema 与编译器校验
- [ ] **P1-C2** ActionRuntime 事务写回
- [ ] **P1-C3** Action Log 审计对象
- [ ] **P1-C4** Ontology-as-code round-trip
- [ ] **P1-C5** Submission criteria 引擎
- [ ] **P1-D1** Verified Answers 注册表
- [ ] **P1-D2** 语义缓存升级
- [ ] **P1-D3** 假设透明化（Assumptions）
- [ ] **P1-D4** 引用深化到字段级
- [ ] **P2-E1** MCP Server（只读原语暴露）
- [ ] **P2-E2** Open Semantic Interchange 导出
- [ ] **P2-E3** evalMetrics SLO 面板

---

## Phase P0：评估体系 + 生成增强（预计 1.5-2 周）

### Task A1: 评估数据集 schema + 50 题种子集
**Files:**
- Create: `src/test/server/evals/dataset/golden-v1.jsonl`
- Create: `src/test/server/evals/loader.mjs`（loader 不进 server/ 运行时）

**Step 1: 定义行 schema（每行一个 golden case）：**
```json
{"id":"ev-001","q":"上个月 BCM 停演缺陷趋势","intent":"metric_query",
 "expect":{"metrics":["defect.showstopper_count"],"dims":["time.test_week"],"filters":{"product.ecu":"BCM"},"time":"2026-07"},
 "note":"术语: 停演→concept.showstopper"}
```
**Step 2:** 手工构造 50 题覆盖 15 意图 × 高频实体（quality.defect 12 / testing 10 / traceability 6 / organization 5 / 长尾 7 / 澄清应拒答 5 / 越权应拦 5）。
**Step 3:** vitest 校验 loader：`src/test/server/evals/loader.test.ts` — 断言 50 行、schema 完整、id 唯一、intent 分布。
**Acceptance:** `npx vitest run src/test/server/evals/loader.test.ts` PASS；`npm run test:eval` 前置就绪。

### Task A2: 离线 eval runner（无 LLM 模式）
**Files:**
- Create: `server/agentRuntime/evalRunner.mjs`
- Test: `src/test/server/evalRunner.test.ts`

**TDD:** 先写失败测试：给 3 个 mini case → runner 走 `semanticFrame→resolver→timeResolver→queryPlanner→validator` 全链路（mock 固定时钟）→ 输出 `{pass,fail,skipped,accuracy,byIntent:{...}}`。断言 plan 的 metrics/dims/filters 与 expect 集合相等即 pass（顺序无关）。
**实现要点：** 不依赖 FastAPI/LiveDB——planner 输出计划即可比对（对齐 G1：Genie Chat 模式也是答案比对）；LLM-judge 留 `judge:"llm"` 可选字段给 A6。
**Acceptance:** `npx vitest run src/test/server/evalRunner.test.ts` PASS；`node server/agentRuntime/evalRunner.mjs --dataset src/test/server/evals/dataset/golden-v1.jsonl` 输出 accuracy 报告 JSON。

### Task A3: 防泄漏机制（对齐 Cortex evaluations）
**Files:**
- Modify: `server/agentRuntime/evalRunner.mjs`
- Test: `src/test/server/evalRunner.leakage.test.ts`

**TDD:** 测试：golden case 命中 semanticCache/verified（若 A 后续任务实现）时，evalRunner 必须先摘除该条目再跑（对齐 G2）。当前先对 semanticCache 实现：eval 模式下 `feedbackAndCache.lookup()` 返回 null（注入 `mode:"eval"`）。
**Acceptance:** 测试证明同问在 eval 模式不命中缓存；报告含 `leakageGuard:true` 字段。

### Task A4: 回归命令 + 趋势基线
**Files:**
- Modify: `package.json`（`test:eval` script）
- Create: `src/test/server/evals/baseline-2026-08-16.json`（首跑存档）

**Step:** `npm run test:eval` = vitest evalRunner + 与 baseline diff，accuracy 下降 >2pp 即 exit 1（对齐 Cortex regression 指标）。
**Acceptance:** 故意在 dataset 改坏 1 题期望 → CI 式命令 exit 1；恢复后 exit 0。

### Task A5: 线上线下打通
**Files:**
- Modify: `server/agentRuntime/evalMetrics.mjs`（增加 `GET /api/ai/metrics/offline-vs-online`）
- Test: `src/test/server/evalMetricsOffline.test.ts`

**内容:** 离线 accuracy 与线上 task success rate 并排展示 + 偏差告警字段（offline 高 online 低 → 线上分布漂移）。
**Acceptance:** API 返回 `{offline:{accuracy,n},online:{successRate,n},divergencePct}`；测试断言 divergence 计算。

### Task B1: SchemaLinker（embedding 可插拔）
**Files:**
- Create: `server/ontology/schemaLinker.mjs`
- Test: `src/test/server/ontology/schemaLinker.test.ts`

**TDD:** 接口 `linkQueryTokens(query, ontology) → {matchedDims:[],matchedMetrics:[],matchedEntities:[],scores:{}}`。默认实现 TF-IDF cosine（82 terms+51 dims+31 metrics 做 corpus），`embedder` 参数可注入 BGE（生产机有现成 BGE 服务）。测试：'“问题单按 ECU”' → matchedDims 含 product.ecu，matchedEntities 含 quality.defect（对齐 G3）。
**接线:** resolver.mjs 消歧失败时 fallback 调 schemaLinker（不改变现有命中优先级）。
**Acceptance:** schemaLinker 单测 PASS；resolver fallback 集成测试 PASS。

### Task B2: 多路径查询计划（CHASE-SQL 迁移）
**Files:**
- Modify: `server/ontology/queryPlanner.mjs`（增加 `mode:"multi"`）
- Create: `server/ontology/planCandidates.mjs`
- Test: `src/test/server/ontology/planCandidates.test.ts`

**TDD:** `generateCandidates(frame) → [directPlan, decomposedPlan, constraintFirstPlan]`：
- direct：现有单路径
- decomposed：复合问题拆子计划（如"按ECU的TOP模块趋势"→ group-by 两步）
- constraintFirst：先收敛 filter 再聚合
测试断言：3 候选生成、每个过 validator、planFingerprint 各不相同（对齐 G4）。
**注意：** LLM 参与路径生成时走现有 chatModelConfig；无 LLM 时退化为 direct+constraintFirst 双路径（rule 可推）。
**Acceptance:** vitest PASS；`NODE_OPTIONS=--experimental-vm-modules` 下 670 存量测试不回归。

### Task B3: 执行投票（execution voting）
**Files:**
- Create: `server/ontology/planVoting.mjs`
- Test: `src/test/server/ontology/planVoting.test.ts`

**TDD:** `vote(candidates, executeFn) → {winner, verdict:"UNANIMOUS"|"MAJORITY"|"DISAGREE", evidence}`。executeFn 用 FastAPI dry 聚合（现有 analyze 通道，LIMIT 小样本行数/聚合签名比对）。DISAGREE → 降级：不直接回答，输出"结果存在分歧，建议精确化问题"并附候选差异（对齐 G5，宁澄清不硬答——Cortex 同款哲学）。
**接线:** analyze 原语 `mode:"multi"` 时启用；默认单路径不回归。
**Acceptance:** 单测（mock executeFn 三种一致性场景）PASS；intent=metric_query 的 golden 不回归。

### Task B4: 自纠错环增强
**Files:**
- Modify: `server/mainAgentToolRecovery.mjs`
- Test: `src/test/server/mainAgentToolRecovery.multi.test.ts`

**内容:** recovery 重试时注入 B2 候选计划（失败计划 → 换路径而非仅换参数）；重试上限仍 1 次；DISAGREE 不算失败不触发 recovery。
**Acceptance:** 测试：模拟 direct 失败 → recovery 用 constraintFirst 成功；全量 `npm test` 绿。

---

## Phase P1：Ontology 操作层 + 信任原语（预计 2-3 周，P0 完成后）

### Task C1: Action Type schema 与编译器校验
**Files:**
- Create: `ontology/v1/actions.json`
- Modify: `server/ontology/registry.mjs`（编译 actions）
- Test: `src/test/server/ontology/actionsCompile.test.ts`

**内容（对齐 Palantir Action Type，对齐 G6）：**
```json
{"id":"quality.defect.update_status","label":{"zh-CN":"更新缺陷状态"},
 "targetEntity":"quality.defect","mutation":{"fields":["status","resolution_time"],"writeback":"quality.defect_writeback"},
 "submissionCriteria":[{"userGroup":"dtsv_team"},{"approval":{"kind":"defect_write","ttlMin":15}}],
 "sideEffects":[{"type":"action_log"},{"type":"notify","channel":"feishu"}]}
```
**TDD:** 编译器校验：mutation.fields ⊆ 实体属性、writeback dataset 声明、criteria 引用的组存在；非法 actions.json → 编译错误。首批 3 个 Action：update_status / link_duplicate / propose_testcase（替代现有 testCaseProposal 的 ad-hoc 路径）。
**Acceptance:** `npm run test:ontology` PASS。

### Task C2: ActionRuntime 事务写回
**Files:**
- Create: `server/agentRuntime/actionRuntime.mjs`
- Test: `src/test/server/actionRuntime.test.ts`

**TDD:** `submitAction(actionId, payload, actor)` → ①criteria 评估 ②approvalFlow（复用现有两阶段）③事务写入 writeback dataset（BEGIN/COMMIT，失败回滚）④触发 sideEffects。测试：无批准 → pending；批准 → 写入成功 + 行出现在 writeback；写冲突 → 回滚（对齐 Palantir 单 Action = 单事务）。
**API:** `POST /api/ai/actions/:id/submit` + `POST /api/ai/actions/:id/approve`。
**Acceptance:** vitest PASS；FastAPI 侧 `backend/tests/test_ontology_contract.py` 补 writeback 表契约。

### Task C3: Action Log 审计对象
**Files:**
- Create: `ontology/v1/entities.json` 增 `quality.action_log`
- Modify: `server/agentRuntime/actionRuntime.mjs`
- Test: `src/test/server/actionLog.test.ts`

**内容（对齐 G8/Palantir Action Log）：** 每次提交自动生成 `[LOG]` 对象：action_rid、action_version（每次定义变更自增）、timestamp、actor、目标主键、diff（前后值）、审批人。查询 API：`GET /api/ai/actions/log?entity=quality.defect&since=`。evidence 契约：action_log 可被 citation 引用。
**Acceptance:** 写回 → log 对象存在且字段完整；时间线查询按时间倒序正确。

### Task C4: Ontology-as-code round-trip
**Files:**
- Create: `scripts/ontoExport.mjs` / `scripts/ontoApply.mjs`
- Test: `src/test/server/ontologyRoundTrip.test.ts`

**内容（对齐 G9）：** `onto export` → 把 compiled ontology 拆成 v1/*.json 美化输出（key 排序，git-diff 友好）；`onto apply` → 校验+重编译+driftReconciler diff 报告（复用现有 publish/diff）。CI 上跑 export 后 `git diff --exit-code` 保证制品与源一致。
**Acceptance:** round-trip 测试：export→apply→export 三点等价；人为改 compiled 不改源 → diff 报 critical。

### Task C5: Submission criteria 引擎
**Files:**
- Create: `server/agentRuntime/submissionCriteria.mjs`
- Test: `src/test/server/submissionCriteria.test.ts`

**内容（对齐 G7）：** 条件类型：userGroup / actorAttribute / timeWindow（businessCalendar 联动）/ scenario（是否沙盘）。`evaluate(criteria[], ctx) → {allowed:boolean, unmet:[...]}`。全部满足才可提交，错误消息明示哪个条件不满足。
**Acceptance:** 4 类条件单测 + 组合 AND 语义测试。

### Task D1: Verified Answers 注册表
**Files:**
- Create: `ontology/v1/verified.json`
- Create: `server/ontology/verifiedAnswers.mjs`
- Test: `src/test/server/ontology/verifiedAnswers.test.ts`

**内容（对齐 G10/Genie trusted assets）：** 触发短语 → 参数化计划模板（不是缓存答案！）：`{"triggers":["周报","weekly report"],"planTemplate":"qgate_weekly","params":{"weeks":1},"verifiedBy":"Tony","verifiedAt":"2026-08-20"}`。命中 → 跳过生成直接执行计划，回答标"✅ Verified answer"（区别于生成答案）。管理：eval 防泄漏规则同样适用（A3 扩展）。
**Acceptance:** 命中测试 + 未命中走正常路径 + eval 模式摘除。

### Task D2: 语义缓存升级
**Files:**
- Modify: `server/agentRuntime/feedbackAndCache.mjs`
- Test: `src/test/server/feedbackAndCache.vector.test.ts`

**内容（对齐 G11）：** 三层匹配：精确 → TF-IDF cosine（≥0.85）→ Jaccard（≥0.8 现状保留为兜底）。hitRate 指标进 evalMetrics。BGE 注入口留好（生产机部署后一键切换）。
**Acceptance:** "上礼拜的缺陷"能命中"上周的缺陷"缓存（TF-IDF 层）；hitRate API 可查。

### Task D3: 假设透明化（Assumptions）
**Files:**
- Modify: `server/ontology/resolver.mjs`（输出 `assumptions[]`）、`server/ontology/timeResolver.mjs`
- Modify: 前端 `src/.../AIChat*.tsx`（Assumptions 折叠面板）
- Test: `src/test/server/resolverAssumptions.test.ts`

**内容（对齐 G12/Amazon Quick Explanation）：** 每次消歧/时间解析产出 `{term,interpretedAs,confidence}`；回答附 assumptions 区块；用户点击可纠正（"不是这个意思"→ 作为澄清反馈进 sessionEventLog）。
**Acceptance:** API 返回 assumptions；前端组件快照测试；纠正反馈被记录。

### Task D4: 引用深化到字段级
**Files:**
- Modify: `server/mainAgentEvidence.mjs`
- Test: `src/test/server/evidenceFieldLevel.test.ts`

**内容：** analysisRef 结构从结果集级扩展 `rowRefs:[{pk,fields:[]}]`，answerValidator 校验数值引用时定位到具体行字段（防"聚合值张冠李戴"）。
**Acceptance:** validator 拒绝引用不存在字段的数值；合法引用通过。

---

## Phase P2：生态开放（预计 1-2 周，P1 完成后）

### Task E1: MCP Server（只读原语暴露）
**Files:**
- Create: `server/mcp/server.mjs`（MCP stdio + HTTP transport）
- Test: `src/test/server/mcpServer.test.ts`

**内容（对齐 G13/Palantir OMCP）：** 暴露 3 个工具：`ontology_catalog`（元数据）、`governed_analyze`（analyze 原语透传，actor 从 MCP 会话映射）、`action_submit`（P1 C2 透传，仍走审批）。**不暴露 raw SQL。** 环境变量 `VIZION_MCP=1` 启用。
**Acceptance:** MCP 协议握手+工具调用集成测试（用 @modelcontextprotocol/sdk test utils 或手写 JSON-RPC 断言）。

### Task E2: Open Semantic Interchange 导出
**Files:**
- Create: `scripts/osiExport.mjs`
- Test: `src/test/server/osiExport.test.ts`

**内容（对齐 G14）：** metrics/dimensions/terms → OSI 兼容 YAML（dbt MetricFlow/SemanticLayer 风格字段名映射）。先做单向导出（互操作入口），双向待标准成熟。
**Acceptance:** 导出 YAML 通过 dbt metrics schema 校验（或最小子集断言）。

### Task E3: evalMetrics SLO 面板
**Files:**
- Modify: `server/agentRuntime/evalMetrics.mjs`、前端 StatsPanel
- Test: `src/test/server/evalMetricsSlo.test.ts`

**内容：** p50/p95 延迟、token/问、成本估算、SLO 达成率（success≥90% / p95≤8s）；偏离 SLO 输出告警事件。
**Acceptance:** SLO 计算单测；面板渲染冒烟。

---

## 进度追踪协议（Review 入口）

```bash
# 查看未完成任务
grep -n "^\- \[ \]" docs/plans/2026-08-16-agent-upgrade-program.md
# 完成任务后勾选
sed -i '' 's/- \[ \] Task B3/- [x] Task B3/' docs/plans/2026-08-16-agent-upgrade-program.md
```

对 Agent 说 **“Review 升级计划进度”** → 执行：读未勾选任务 → git log 核对每项是否已有实现 commit → 报告真实完成度（代码为准，不信记忆）→ 从第一个未完成任务继续。

## 完成定义（DoD）

- [ ] `npm run test:eval` 可跑，accuracy ≥85% 且防泄漏生效
- [ ] 多路径+投票：DISAGREE 场景宁澄清不硬答，golden 不回归
- [ ] Action 写回：3 个 Action 上线，事务+审计+criteria 全链路测试绿
- [ ] Verified answers：≥5 条常用查询命中，UI 显示 Verified 标
- [ ] 全量 670+ 存量测试保持绿；每任务独立 commit
- [ ] P2：MCP server 可被外部 Claude/标准 MCP 客户端调用（只读+审批写）
