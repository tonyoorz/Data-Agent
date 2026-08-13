# GOAL:Data-Agent 持续进化使命书(交给 Coding Agent 的循环进化目标)

> **版本**:v1.0 · 2026-08-11
> **用法**:把本文件整个交给你的 Coding Agent(Claude Code / Cursor / WorkBuddy 等),让它**按本文档定义的循环协议反复执行**,每一轮都让仓库变得更好一点。没有终点命令,除非用户明确说"停止"。
> **关联文档**:`智能问数Agent目标架构设计.md`(目标架构与 P0-P3 路线图)、`docs/data-agent-competitive-positioning-2026-08-10.md`(事实核查后的真实能力清单)。

---

## 1. 北极星使命(North Star)

把本仓库(Data-Agent)进化为**企业级最佳的中文智能问数 Agent 系统**——在以下六个维度上全面超越 Snowflake Cortex Analyst、Vanna、阿里 Quick BI 智能小Q、Microsoft Copilot in Power BI,以及学术 SOTA(CHESS / DIN-SQL / MAC-SQL / DAIL-SQL):

| 维度 | 当前自评 | 目标 | 含义 |
|------|---------|------|------|
| **正确性** | ~6/9 | ≥8.5/9 | NL→语义→SQL→行→答案,端到端正确,有 golden 回归 |
| **稳定性** | ~2/9 | ≥8/9 | LLM 5xx/超时/限流自动恢复;闲聊/越界误路由率 < 5%;失败 100% 留痕 |
| **可解释性** | ~6/9 | ≥8.5/9 | 每个数据结论带可程序化校验的引用链(工具/版本/行级来源) |
| **可治理性** | ~6/9 | ≥8.5/9 | 只读、敏感度、行级权限、审批路径被策略强制执行 |
| **可观测性** | ~1.5/9 | ≥8/9 | 结构化 tracing/span、失败可复现、延迟与成本可度量 |
| **可演进性** | ~3/9 | ≥8/9 | eval-driven 闭环:每次改动自动回归,新增功能无 eval 不过审 |

**核心战略**(来自架构设计,不可偏离):**"先让系统不掉 → 再让系统不乱说 → 最后让系统持续变准。"**
落地顺序:`P0(韧性) → P0.5(持久记忆) → P1(输出契约) → P1.5(语义准确) → P2(评测飞轮) → P2.5(洞察叙事) → P3(关系推理)`。

**差异化护城河**(不要丢掉):受治理的本体语义层(ontology as single source of truth)+ 证据绑定答案 + 汽车测试质量领域语义(DTSV/Q-Gate)。不要把它做成又一个通用 text-to-SQL 玩具。

---

## 2. 你的身份与工作方式

你是一名**资深 Agent 系统架构师 + 全栈工程师**,被授予本仓库的持续进化权。你的运行方式是**无限循环**:

```
┌─────────────────────────────────────────────────────────────┐
│  每轮循环(One Evolution Loop)                                │
│                                                             │
│  1. SENSE   重读本文件 + docs/evolution-journal.md(进度日志) │
│             + 最近一次 git log,确认"现在进行到哪了"           │
│  2. DECIDE  从 §5 Backlog 中选取当前最高优先级的未完成项,      │
│             把它拆成本轮可交付的最小改动(single loop = 一个小步)│
│  3. ACT     实现改动:代码 + 测试 + (如需要)文档               │
│  4. VERIFY  运行 §4 的验证命令,全部通过才算完成               │
│  5. RECORD  把本轮做了什么/验证结果/下一轮建议,追加写入        │
│             docs/evolution-journal.md,然后 git commit         │
│  6. LOOP    回到第 1 步,开始下一轮                             │
└─────────────────────────────────────────────────────────────┘
```

**每轮铁律**:
- **一轮只做一件小事**。宁可 10 轮小步快跑,不要 1 轮大爆炸式重构。
- **先写/改测试,再改实现**(TDD)。没有验证手段的改动不允许提交。
- **验证全绿才提交**;验证不过就修复,修复不了就回滚本轮改动并在日志中记录原因,然后下一轮换一个更小的切入点。
- **永远保持主干可运行**:任何时候 `npm run test` 和 `npm run test:agent-evals` 不能比本轮开始时更红。
- 拿不准优先级时,永远选"让系统更稳定/更可度量"而不是"更聪明"。

---

## 3. 仓库现状速览(进化前必读)

### 3.1 运行时架构(当前生产路径)
- **网关**:`server/index.mjs`(HTTP/SSE,端口 3004)
- **Agent Runtime**:`server/agentRuntime/langGraphChatRuntime.mjs` — LangGraph StateGraph,6 节点:`initialize → resolve_context → route_tools → plan_tool_calls ⇄ execute_tool_calls → finalize`
- **工具编排(ReAct)**:`server/mainAgentToolOrchestrator.mjs`(≤4 步、每步 ≤3 工具、策略门控、空结果自愈);配套 `mainAgentToolLoop/Planning/Registry/Recovery/Toolsets.mjs`
- **意图路由**:`server/mainAgentIntentRouter.mjs`、`mainAgentDirectIntent.mjs`(当前仍是偏窄的路由,闲聊/越界分支待加固)
- **语义层(本体)**:`ontology/v1`(10 个 JSON,~7k 行)+ `server/ontology/*.mjs`(analysisPlanner/queryPlanner/guardrails)+ `backend/analytics/semantic_query.py`;编译/校验:`npm run ontology:check`
- **LLM 传输**:`server/companyChat.mjs`(⚠️ 缺 timeout/retry/熔断,P0 第一项)
- **输出校验**:`server/answerValidator.mjs` + `mainAgentEvidence.mjs`(引用校验已起步,需固化为契约)
- **分析 sidecar**:Python `backend/analytics/`(FastAPI :3003,hot/cold 数据层、Q-Gate 报表等)
- **前端**:`src/`(Vite + React)

### 3.2 已被事实核查"打假"的能力(❌ 不存在,不要再引用,可列入进化目标)
GraphRAG 子图注入、CHASE-SQL 多路径投票、QueryMemory(SQLite+embedding 统一查询记忆)、8 维 200 分风险模型、CodeInterpreter 沙箱、本体 AutoUpdate 闭环、Schema Drift 自动检测修复。详见 `docs/data-agent-competitive-positioning-2026-08-10.md`。
**规则:任何对外/对内宣称的能力,必须在代码中可复现;写文档时区分"已实现 / 部分实现 / 规划中"。**

### 3.3 关键缺口(按优先级)
1. LLM 调用无 retry/timeout/降级/熔断;失败 run 不留审计 → **P0**
2. 意图分流不稳(闲聊/越界/元数据探索/写意图无显式分支)→ **P0**
3. `finalize` 输出无程序化契约,幻觉引用可漏网 → **P1**
4. Schema linking 是子串首匹配;关系/业务规则/LLM 消歧未接入运行时 → **P1.5**
5. evals 只测路由,不测 SQL 行/答案/引用;无 CI → **P2**

---

## 4. 验证命令(每轮必须执行)

```bash
# 静态检查
npm run lint
npm run ontology:check        # 本体编译/指纹校验

# 单元 + 组件测试
npm run test                  # vitest 全量
python -m pytest backend/tests -q   # 后端 Python 测试(若改动触及 backend/)

# Agent 行为 golden(改动 agent/语义/工具链路时必跑)
npm run test:agent-evals

# 本体专项(改动 ontology/ 时必跑)
npm run test:ontology

# 冒烟(大改后):能起服务
npm run start &               # :3004 网关
curl -s http://127.0.0.1:3004/health || true
```

判定:**所有改动前已绿的命令必须保持全绿**;你新加的测试必须绿。若基线本身有红,先在日志中记录基线状态,再决定是修基线还是绕开。

---

## 5. 进化 Backlog(按序推进,完成一项勾一项)

> 状态记录在 `docs/evolution-journal.md`;下表是源头清单。每一项的"验收标准"来自 `智能问数Agent目标架构设计.md` §6.2。

### P0 — 稳定运行(让系统不掉)
- [ ] **P0-1** `companyChat.mjs` 加 timeout/retry(指数退避)/fallback 模型/熔断器;LLM 单点故障自动恢复
- [ ] **P0-2** `server/index.mjs` 加 body limit、全局请求超时、panic 兜底
- [ ] **P0-3** `graph.invoke` 包 `finally`:失败 run 100% 写审计事件(含错误类型、耗时、输入摘要)
- [ ] **P0-4** 多分支意图分类器:`chitchat / out_of_scope / metadata_explore / write_intent / analytics` + 置信度门控;闲聊模板化回答;闲聊误路由率 < 5%(新增 golden 集验证)

### P0.5 — 持久化记忆
- [ ] **P0.5-1** `MemorySaver` → `SqliteSaver`,checkpoint 含完整 ChatState;服务重启后 thread 可恢复

### P1 — 输出可解释(让系统不乱说)
- [ ] **P1-1** `finalize` 输出 JSON Schema 契约 + 程序化 citation 校验(答案中每个事实性断言可追溯到工具结果)
- [ ] **P1-2** `answerValidator.mjs` 后置校验拦截幻觉引用;evidence 携带 `ontologyVersion` / `schemaFingerprint`
- [ ] **P1-3** 失败兜底话术统一(不暴露内部错误,给出可操作建议)

### P1.5 — Schema Linking 升级(让系统理解准)
- [ ] **P1.5-1** ontology RAG 索引(BM25 + 向量),替换子串首匹配
- [ ] **P1.5-2** 歧义自动澄清机制(低置信度→向用户提问,而非硬猜)
- [ ] **P1.5-3** 业务规则/约束真正接入 planner 并被执行(目前 3 条可执行,其余是文档)
- [ ] **P1.5-4** schema linking 准确率 ≥ 90%(建测试集度量)

### P2 — 评测飞轮(让系统持续变准)
- [ ] **P2-1** `evals/` 扩展为 L1-L5:路由 / 语义帧 / 工具序列 / 结果集不变量 / 答案与引用忠实度
- [ ] **P2-2** `scripts/runEvals.mjs` 一键跑分 + 趋势记录(准确率基线与回归线)
- [ ] **P2-3** `.github/workflows/eval.yml`:PR 自动跑 eval,新增功能无 eval 不过审
- [ ] **P2-4** 生产 feedback 入库,反哺 golden 集

### P2.5 — 结果叙事与图表
- [ ] **P2.5-1** `analyze_results` 节点:统计摘要 + 洞察生成 + 图表推荐,前端渲染

### P3 — 关系推理与复杂规划
- [ ] **P3-1** `relationships.json` 多跳路径展开;lineage/traceability 类问题走关系推理
- [ ] **P3-2** 显式 `plan_query` 分解节点(简单单步 / 复杂分解可切换)
- [ ] **P3-3** Python traceability 图改为读 ontology,消除硬编码

### 持续项(每轮都可顺带做)
- 消除"宣称但未实现"的文档泡沫(对照 competitive-positioning 文档逐条核销或实现)
- 可观测性补强:结构化 span/延迟/成本日志
- 死代码清理、重复逻辑收敛、类型与注释补强
- 每完成一个 P 阶段,更新 `智能问数Agent目标架构设计.md` 的成熟度雷达与自评分

---

## 6. 硬性约束(违反任何一条 = 本轮作废回滚)

1. **只读治理不可削弱**:`NO_ARBITRARY_SQL`、`NO_ARBITRARY_CODE`、行数预算、敏感度策略、actor-scope 校验——只能加强,不能绕过。
2. **本体是单一事实源**:新指标/维度/关系先进 `ontology/`,再接代码;禁止在代码里硬编码业务语义。
3. **不引入未声明的新依赖**;确需引入时,在日志中说明理由与替代方案。
4. **不破坏既有数据与数据库文件**(`database/`、`backend/database/*.db` 只读使用)。
5. **commit 纪律**:每轮一个原子 commit,message 格式 `[evo][P{x}-{n}] 一句话说明`;禁止提交 `node_modules`、`.env`、构建产物。
6. **文档诚信**:能力描述必须标注 已实现/部分实现/规划中;禁止夸大。
7. **中文优先**:面向用户的文案、日志、文档用简体中文;代码注释可用英文。

---

## 7. 进度日志格式(docs/evolution-journal.md)

每轮循环结束后追加(不存在则创建):

```markdown
## Loop #N · YYYY-MM-DD HH:mm
- **本轮目标**:(对应 Backlog 编号,如 P0-1)
- **改动文件**:...
- **新增/修改测试**:...
- **验证结果**:lint ✅ / test ✅(xx passed)/ agent-evals ✅ / ontology:check ✅
- **基线对比**:(绿了哪些、还红哪些)
- **自评**:稳定性 x/9 → y/9(只调有依据的分)
- **下一轮建议**:...
- **阻塞/风险**:...
```

---

## 8. 何时算"超越"(长期终态画像)

当以下全部为真时,可以向用户宣布"阶段胜利"并请求评审:
1. §5 Backlog 全部勾选,成熟度六维雷达全部 ≥ 8/9 且每项分数都有 eval/测试证据支撑;
2. `npm run test:agent-evals` 覆盖 L1-L5,CI 自动回归,准确率趋势可查询;
3. 闲聊误路由率 < 5%、citation 可追溯率 100%、LLM 故障自动恢复有演练记录;
4. 架构设计文档与代码事实零偏差(competitive-positioning 式核查能通过)。

在那之前:**继续循环,永不停歇。每轮结束,直接开始下一轮。**
