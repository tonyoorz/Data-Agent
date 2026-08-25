# Data-Agent 补全计划 · 按"智能 / 效率"价值密度排序

> 日期:2026-08-10 · 基于 08-10 代码核查基准(`feature/2026-08-10-governed-agent-production-sync`)
> 衔接:`docs/data-agent-competitive-positioning-2026-08-10.md`(你的诚实定位核查)+ `docs/research/智能问数Agent全网调研-2026-08-10-更新.md`(业界对标)
> 适用对象:你自己(垂直 DTSV 缺陷分析 agent,BMW ZE-361,单源 Octane)

---

## 0. 核心原则:不为补而补

你的导向是对的——补全的判据**不是"业界有我没有"**,而是"补了之后是否让 agent **更智能**(更准 / 更自治 / 有洞察)或 **更高效**(更快 / 更省 / 更稳)"。由此推出三条筛选规则:

1. **不能被度量验证的改进,先建度量**。在 scorecard 之前,任何"更智能"都是主观判断——先把尺子造出来,否则你补完也不知道有没有用。
2. **性价比(价值 ÷ 工作量)优先于教条 P0/P1/P2**。10 分钟能换 10× 并发的改动,优先级高于 2 周才能做完的功能。
3. **单源 / 单链够用时,不引入多源 / 多 agent 的复杂度**。你目前单源 Octane、单链 LangGraph——多 agent 和联邦的收益要等 scorecard 证明"某类问题现在的架构搞不定"才做。

下面所有"暂缓项"都是基于规则 3,不是遗漏。

---

## 1. 价值矩阵(看清性价比再动手)

图例:智能提升 / 效率提升 用 ★(大)/ ◐(中)/ ·(无);工作量用人时(粗估);价值密度 = 综合提升 ÷ 工作量。

| # | 补全项 | 智能提升 | 效率提升 | 工作量 | 价值密度 | 对标 |
|---|---|:---:|:---:|:---:|:---:|---|
| ① | **task scorecard**(度量基线) | ★ | ◐ | 2-3 天 | **极高** | Spider2.0 / Cortex Eval / LangSmith |
| ② | **工具并行 + SQLite WAL** | · | ★ | **0.5 天** | **极高** | 7d-gap-analysis 维度5 |
| ③ | **business_rules 全生效** | ★ | · | 3-5 天 | 高 | WrenAI instructions / Palantir |
| ④ | **结果校验扩展(MARS 五规则)** | ★ | · | 2 天 | 高 | MARS-SQL / answerValidator 扩展 |
| ⑤ | **SqliteSaver + 熔断器** | · | ★ | 1-2 天 | 高 | opossum / LangGraph checkpointer |
| ⑥ | **per-user 授权边界合并** | ·(但解锁多用户) | ◐ | 1 天(合并)+ 2 天(验证) | 高 | Databricks UC / Cortex RBAC |
| ⑦ | **可视化渲染** | ◐ | · | 3-5 天 | 中 | Text2SQL.ai / Vanna |
| ⑧ | 模型路由(scorecard 后) | ◐ | ★ | 2 天 | 中(scorecard 后才有意义) | Cortex 自动选模 |
| ⑨ | 受控主动洞察 | ★ | · | 5-7 天 | 中 | ThoughtSpot Spotter |
| ⑩ | ontology learning loop | ★ | · | 1-2 周 | 中 | WrenAI memory |
| ⏸ | 多 agent 拆分 | ◐ | · | 2-3 周 | **低(暂缓)** | CHESS / MAC-SQL |
| ⏸ | 沙箱执行 | ◐ | · | 2-3 周 | **低(暂缓)** | DB-GPT |
| ⏸ | 多源联邦 | · | ◐ | 3-4 周 | **低(暂缓)** | LinkAlign |
| ⏸ | WrenAI 嵌入 | · | · | 1-2 周 | **低(已降 P2)** | wren-core |

---

## 2. 推荐执行(按价值密度降序,每项给"为什么 + 怎么做")

### ① task scorecard —— 元能力,防盲补(最高优先,必做第一件)

**为什么(智能价值)**:你 competitive-positioning 文档的原话——"accuracy 仍是 Unknown"。在 scorecard 存在之前,你补 business_rules 也好、补多 agent 也好,**都无法证明"补了之后变好了"**。这是唯一一项"让其他所有改进变得可验证"的元能力,所以优先级最高,哪怕它本身不直接提升智能。

**为什么(效率价值)**:scorecard 跑起来后,会自动暴露"哪类问题慢 / 哪类问题错 / 哪条规则没生效"——直接告诉你下一步该补什么,避免瞎补。

**怎么做**(代码级):
1. **选 60-100 个真实 DTSV 问题**:从生产 query log 抽(你已有运行时审计 `runtimeAuditStore.mjs` 的 run-events.jsonl)+ 人工补足 10 类覆盖:aggregate / trend / rank / drilldown / traceability / coverage / ambiguity / empty-recovery / denied-access / citation。
2. **每例 expected 字段**(存 `evals/main-agent/target/task-scorecard.jsonl`):
   - `question` + 澄清历史
   - `expected_semantic_frame`(intent/metricIds/dimensionIds/filters/timeScopes)
   - `allowed_tool_sequence`(允许的工具调用序列)
   - `expected_result_or_invariant`(snapshot-pinned 结果集;数值取 4 位有效数字相等;接受不同排序)
   - `expected_auth_outcome`(actorScope 是否被拒 / sensitive field 是否脱敏)
   - `expected_citation_status`(需要几个引用 / 是否允许因果声明)
3. **runner**(`evals/task_scorecard_runner.mjs` 或接 LangSmith dataset/evaluator loop):每例跑 agent → 记 6 个指标:task_success / policy_non_bypass / evidence_validity / recovery_success / P50-P95_latency / model_route。
4. **触发**:ontology / planner / prompt / model 变更时自动跑(CI 一旦建好就挂 CI;在那之前手动 `npm run eval:scorecard`)。
5. **对比尺**:Spider2.0 真实场景最高 44.5%、BIRD-INTERACT 多轮最高 21% 是地板——你的 DTSV 场景定自己的基线,不要拿 BIRD 81.95% 吓自己。

**工作量**:2-3 天(选题 1 天 + runner 1 天 + 跑通调优 0.5 天)。

---

### ② 工具并行 + SQLite WAL —— 性价比之王(10 分钟换数量级)

**为什么(效率价值)**:这是全部补全项里**性价比最高**的——改动几乎为零,收益是数量级。

**怎么做**(代码级,两件事):

**a. SQLite WAL**(`backend/analytics/db.py` 的 `connect()`):
```python
def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")        # 读写不互斥
    conn.execute("PRAGMA busy_timeout=5000")       # 并发写等待而非立即抛 locked
    conn.execute("PRAGMA synchronous=NORMAL")      # WAL 下安全,吞吐 ×2-3
    conn.row_factory = sqlite3.Row
    return conn
```
注意:确认所有 sqlite 连接是 **per-request 创建**而非全局共享(WAL 下共享连接仍会串行化)。

**b. 工具并行**(`server/mainAgentToolOrchestrator.mjs`):当前的 `for...await executeOne`(串行)改成对**无依赖**的 tool call 用 `Promise.allSettled`。依赖判定规则:
- **只读 analytics 查询**(不同 metric / 不同 entity)→ 可并行
- **写 Octane 的工具**(`duplicate_comment_writer` 等)→ 保持串行(幂等问题,见 7d-gap 维度6 P1)
- **同源同 metric 的查询** → 串行(避免竞争)

```javascript
// 伪代码:把无依赖的只读 tool call 分组并行
const [parallel, sequential] = partitionByDependency(toolCalls);
const parallelResults = await Promise.allSettled(parallel.map(executeOne));
const sequentialResults = [];
for (const tc of sequential) sequentialResults.push(await executeOne(tc));
```

**工作量**:WAL 10 分钟;工具并行 2-4 小时(含依赖判定 + 测试)。

**验证**:scorecard 的 P95 latency 应该明显下降(3 个独立查询从 ~3×单查询 降到 ~1×)。

---

### ③ business_rules 全生效 —— 让领域知识驱动决策(智能直接提升)

**为什么(智能价值)**:你 competitive-positioning 核实——**3 条可执行 + 12 条文档级**。这 12 条是你最有价值的领域知识(DTSV 严重缺陷规则 / Q-Gate 语义 / owner 语义),现在只供 LLM 参考,**没有在 plan 生成或结果校验时强制**。让它们生效 = 直接减少"违规统计 / 错误因果结论"。

**怎么做**(代码级):每条文档级 rule 补两个声明之一(或都有):
- `effect`:允许 / 禁止的 `metric+dimension+filter` 组合 → 接 `queryPlanner.mjs` 的 plan 生成校验
- `validation`:对结果集的约束(如"不得返回无 filter 的总体统计")→ 接 `answerValidator.mjs` 的结果校验

例子:
```json
{
  "id": "dtsv.severe_defect_requires_severity_filter",
  "effect": { "require": { "metric": "quality.severe_defect_count", "filter": "severity in [A,B]" } },
  "validation": { "forbid_total_without_filter": true }
}
```
然后:
- `queryPlanner.mjs` plan 生成时:`registry.getBusinessRules().filter(r => r.effect).forEach(checkEffect(plan, r))`
- `answerValidator.mjs` 答案校验时:`validateAnswerContract` 里追加 `checkRuleValidations(evidence, rules)`

**对标**:WrenAI 的 `instructions.md`(业务上下文驱动)+ Palantir(规则运行时执行)。

**工作量**:3-5 天(12 条逐条形式化 + 接 planner/validator + 测试)。建议先挑 3-4 条最高价值的(DTSV 严重缺陷 / Q-Gate 通过率)试水。

---

### ④ 结果校验扩展(MARS 五规则)—— 防 LLM 数值幻觉

**为什么(智能价值)**:`answerValidator.mjs` 已有**因果护栏**(08-10 新补,很好),但缺**数值护栏**。LLM 会在有正确数据的情况下把数字说错(7d-gap 维度7 P1)。这一项直接提升"答案可信度"。

**怎么做**(在 `answerValidator.mjs` 扩展):
- `validateNumericAnchoring`:用正则抽 answer_text 里所有数字,逐一在 evidence 结果集查;找不到 → `ANSWER_NUMERIC_UNANCHORED`。
- `validateUnitConsistency`:单位一致性(缺陷数 vs 百分比 vs 天数)。
- `validateOutlier`:结果值超 μ+3σ 或与历史 snapshot 偏离 >50% → 警示(不阻塞,标注"异常值,建议核对")。

**对标**:MARS-SQL 的"五规则统计校验 + LLM 语义校验器"(arXiv 2511.01008)。你的 `answerValidator` 已经是这个方向,补全数值维度即可。

**工作量**:2 天。

---

### ⑤ MemorySaver → SqliteSaver + 熔断器 —— 可运维基础

**为什么(效率价值)**:两个独立的小改动,合起来解决"重启丢会话 + 故障雪崩"。

**怎么做**:
- **SqliteSaver**(`server/agentRuntime/langGraphChatRuntime.mjs:532`):`new MemorySaver()` → `SqliteSaver.from(new SqliteConnOptions(".../checkpoints.db"))`(LangGraph 官方支持,改动约 10 行)。解决重启丢会话 + 可水平扩展。
- **熔断器**:对 Octane(`backend/analytics/ingest/client.py`)和模型 API(`companyChat.mjs`)各维护一个断路器。用 `opossum` 库(开箱即用)或手写 40 行。连续 5 次失败 → 打开 30s → 半开试探。打开时返回友好降级,别让用户等满 30-45s 超时。

**工作量**:1-2 天。

---

### ⑥ per-user 授权边界合并 —— 多用户前置(不是功能,是 release gate)

**为什么**:你 `agentAuth.mjs` 组件已全做完,`worktrees/rls-closure` 里是完成态——**这是合并 + 验证的工作,不是新开发**。合并后才能安全服务多用户。competitive-positioning 把它列为 P0.0 最高战略优先,对——因为"能否上多用户"比"多准"更决定产品能不能用。

**怎么做**:
1. 合并 `rls-closure` worktree 到 main。
2. 跑一遍验证:每个 agent 工具(`mainAgentTools.mjs`)都确认用了 server-derived actor + signed capability + row filter + sensitive-field policy;构造 `{"actorScope":{"projectIds":["*"]}}` 的恶意请求确认被拒。
3. 把"恶意请求被拒 / sensitive field 被脱敏 / scope 缩放"加入 scorecard 的 `policy_non_bypass` 指标。

**工作量**:1 天合并 + 2 天验证。

---

### ⑦ 可视化渲染 —— 体验跃迁(对标 Text2SQL.ai / Vanna)

**为什么**:`analysisPlanner.mjs` 已经产出 `kpi/line/bar/grouped_bar/table` 的 visualization profile——**契约层已就绪,只差渲染**。这是与 Text2SQL.ai / Vanna 的体验差距,且你的 competitive-positioning 明确"constrained renderer of existing plan,不是 code interpreter"。

**怎么做**:
- 把 validated plan 转 UI(前端 vite 8080):根据 `plan.visualization.profile` 渲染对应图表。
- plan + source revision 随可视化持久化(保证可复现)。
- **"按月份分组"这类对话式调整 = 新 semantic-frame amendment,重新 plan**,不是浏览器改数据(你 doc 的关键设计决策)。

**工作量**:3-5 天(渲染 + 对话式 re-plan)。

---

## 3. 明确暂缓项(不为补而补)

| 暂缓项 | 为什么暂缓 | 什么条件下重启 |
|---|---|---|
| **多 agent 拆分**(linking→生成→校验→修订) | 你单链 LangGraph + bounded recovery 已覆盖大部分场景;多 agent 成本 2-3 周 + 运行时复杂度 + 调试难度。收益不确定。 | scorecard 证明某类问题(如歧义多路径)单链准确率 < 阈值 → 借鉴 CHASE-SQL 多路径**仅对低置信触发** |
| **沙箱执行**(code interpreter) | 你的可视化走 constrained renderer(⑦),不需要任意 Python。沙箱引入安全面 + 复杂度。 | 出现"constrained renderer 表达不了"的真实需求(如自定义复杂变换) |
| **多源联邦** | 你目前单源 Octane(7d-gap-analysis 确认)。无第二源,联邦是抽象平台能力,无实际收益。 | 出现第二数据源(如 Jira/SAP)且先定义 source-adapter 契约(schema/freshness/lineage/row-policy) |
| **WrenAI 嵌入** | 已有 answerValidator/agentAuth/受治理计划基础，但 graphPathfinder 仅做拓扑发现，尚未覆盖 wren-core 的可执行 join/多源能力。 | 需 22+ 连接器多源联邦，或 scorecard 证明必须引入完整 join engine |
| **CI(GitHub Actions)** | 重要但不是"智能/效率"本身,是 scorecard 的载体。 | scorecard(①)做完后立刻接 CI——那时 CI 有东西可跑 |

---

## 4. 最小可行跃迁(如果只做 3 件事)

**scorecard(①) + 工具并行/WAL(②) + business_rules 全生效(③)**。

理由:
- ① 让你**可度量**(之后所有改进都能验证——"不为补而补"的根基)。
- ② 让你**更快**(10 分钟换数量级,体感立竿见影)。
- ③ 让你**更准**(领域知识从摆设变强制,直接减少错误答案)。

这三件做完(约 1 周),你从"credible foundation 但 accuracy Unknown"变成"**可度量 + 更快 + 更准**"。之后 ④-⑩ 的顺序**由 scorecard 数据驱动决定**——哪类问题 scorecard 暴露最弱,就先补对应的(歧义多 → 多路径;数值错 → 结果校验;体验差 → 可视化;并发不够 → SqliteSaver/熔断)。

这比任何教条 P0/P1/P2 都更符合你"不为补而补"的导向——**让数据告诉你下一步补什么**。

---

## 5. 与你已有规划的关系

- 本计划**不替代** `docs/data-agent-competitive-positioning-2026-08-10.md` 的 P0-P3(那个是定位 + 优先级框架,本计划是按价值密度的具体做法 + 代码级步骤)。
- 本计划**吸收** `docs/data-agent-7d-gap-analysis.md`(07-30 七维差距)的维度 3/4/5/6/7 的具体建议(WAL / 工具并行 / actorScope / withRetry / scorecard / 数值锚定都来自它)。
- 本计划**对齐** `《智能问数Agent目标架构设计.md》` 的 P1.5(business_rules 接 planner / semanticCandidate 接线——后者你已做完)。
- WrenAI 决策更新见 `docs/research/WrenAI混合集成方案-2026-08.md`(降为 P2,不作废)。
