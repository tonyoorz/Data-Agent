# Data-Agent 业内能力校准与发布门槛

**日期：** 2026-08-11
**代码范围：** `codex/industry-capability-integration` 隔离集成分支
**详细竞品事实核查：** [data-agent-competitive-positioning-2026-08-10.md](./data-agent-competitive-positioning-2026-08-10.md)

## 结论

截图中的表格适合作为能力清单，不适合作为正式 benchmark。它把企业产品、语义层基础设施、开源框架和学术方案放在同一张表中，又把源码证据、论文、商业文档和训练知识标成相同的勾或星；同时没有统一任务集、版本、通过阈值、权重、权限用例、成本或延迟口径。因此，不能据此得出 Data-Agent 已经或尚未达到“业内最佳”的结论。

截图已溯源到历史 commit `479cb617` 中的 `docs/research/智能问数Agent全网调研-2026-08.md`，其矩阵、图例和 P0/P1/P2 文案逐项一致。该历史报告自身也说明部分商业/学术判断依赖截至 2025-05 的训练知识并列出调研局限，所以不应把截图继续当作 2026-08-10 当前分支的验收结果。

Data-Agent 的正确目标也不是把每一列都打勾，而是成为一个面向汽车测试质量场景的单主 Agent：以 Ontology 作为受治理语义内核，执行结构化只读分析，在同一快照上完成聚合、异常分组、明细下钻和证据回答。多 Agent、任意 SQL、任意代码沙箱和 GraphRAG 只有在任务评测证明它们能带来净收益时才进入范围。

## 证据口径

本报告只使用以下状态：

- **A — 已执行验证：** 生产调用链中已接线，并有自动化测试或实际命令结果。
- **B — 已声明未完整执行：** Ontology、schema 或文档存在，但运行时覆盖不完整。
- **C — 计划：** 仅有路线或设计，不能计为现有能力。
- **N/A — 当前不需要：** 不因未实现而扣分；若未来任务数据证明需要，再立项。

“有模块”不等于“能力生效”。一个能力只有同时满足声明、运行时绑定、失败关闭、权限传播、证据输出和可重复资格验证，才能按 A 计。

## 对截图的逐列校准

| 截图维度 | 是否需要 | 当前可证实状态 | 校准结论 |
| --- | --- | --- | --- |
| 语义层建模 | 必须 | 28 entities、51 dimensions、31 metrics；机器可读报告明确 9 `ready`、22 `planned` | **A/B，强基础但非全量可执行。** 不能把 31 个指标全部记为可用 |
| 关系层运行时图遍历 | 有界需要 | 已批准的 AIDA → TestCase → TestRun → Defect trace 垂直切片；一般跨实体维度 join 尚无完整执行适配器 | **A/B，限定能力。** 不能记为完全没有，也不能宣称通用 GraphRAG/任意 join |
| 业务规则运行时执行 | 必须 | 3 条编译型规则在 Node planner 与 Python API 双端生效；其余文档规则不算运行时能力 | **A/B，部分。** 后续按高价值场景逐条编译和评测 |
| Schema linking / 消歧 | 必须 | catalog、业务词汇、字段候选和值检索已接线；超出领域的问题不再默认落到 `defect.count` | **A，受限闭环。** 跨轮待澄清和零结果重链接仍需扩充任务评测 |
| SQL 自校验 / 修订 | 列名不适用 | 产品禁止任意 SQL，使用 schema-validated QueryPlan、逐指标维度 allowlist、只读 operation 和有界 typed recovery | **N/A → 受治理查询验证。** 不应为追求表格勾选而放开 SQL |
| 多 Agent 编排 | 当前不需要 | 一个主 Agent 完成意图、工具、观察和回答；策略集中在 runtime/tool policy | **N/A。** 多 Agent 不是成熟度指标，只有 scorecard 证明单 Agent 成为瓶颈时才引入 |
| 用户权限 / RLS | 必须 | 语义接口使用短期签名 actor capability；FastAPI 服务端重建 scope；22/22 工具分级；checkpoint 按 actor+scope 隔离 | **A（应用层）。** 上线仍需认证网关、真实 IdP 映射和数据源侧策略共同验收 |
| 沙箱执行 | 当前不需要 | 禁止任意代码；已有受治理 visualization contract，但尚未完成消费级 renderer | **N/A。** 先做声明式图表渲染，不把代码执行当首发前提 |
| 评测体系 | 必须 | 5 个 JSONL fixture 集、可实际运行的 gate、commit/Ontology/fixture 绑定的校验工件；明确不是生产准确率 | **A/B。** 工程回归可审计，但真实 DTSV 任务准确率仍未知 |
| 可观测 / 审计 | 必须 | runtime events、tool audit、scope、source revision、answer validation 和 terminal violation 均可记录 | **A/B。** 仍需外部 OTel/日志后端、保留策略和生产 SLO |

## 本次已完成的生产硬化

### 1. 语义能力发布不再“纸面可用”

- 每个 metric 必须声明 `runtime.status`；只有带 adapter ID/version 且和执行字段一致的指标才可标记 `ready`。
- Node Resolver/Planner 与 Python provider 前置门禁分别拒绝 `planned` 指标。
- 所有请求的 dimension、filter、time、comparison 和 sort 字段按每个指标的 allowlist 校验，不使用多指标并集放行。
- 任何一端声称 plan 已 `ready/valid` 时，运行时会重建并比对完整 semantic frame、query plan 与 analysis plan；scope、source、fingerprint、schema、依赖或 canonical args 任一不一致都会阻断，不回退模型重规划。
- 非空数据源中目标维度完全未物化时返回 422；部分缺失会保留 `(missing)` 分组并给出明确 warning，使数据质量缺口可见而不伪装成完整排名。
- `ontology:check` 精确校验 [runtime-capabilities.json](../ontology/generated/runtime-capabilities.json) 与 Ontology fingerprint，报告漂移会失败。

### 2. 身份、范围与会话隔离闭环

- 浏览器提供的 `actor` / `actorScope` 不被信任；Node 从已认证 principal 生成短期签名 capability。
- Python semantic query/records 先验证 capability，再由服务端覆盖构造 actor scope；缺失、篡改、过期和 body 扩权均拒绝。
- 工具被完整分类为 5 metadata、8 scoped data、9 internal-only；OIDC 对 internal-only 和未来未分类工具默认拒绝。
- 客户端 thread ID 不直接作为 checkpoint key；LangGraph checkpoint 与文件快照使用 actor、scope 和 thread 共同派生的不透明哈希键，持久化审计只保留 scope-bound `threadRef`，原始 ID 不落盘。
- 浏览器聊天历史使用已认证 actor 的 opaque namespace；切换账号立即切换会话视图，旧的 origin 级共享 key 被删除，匿名会话不持久化。

### 3. 数据事实先验证后发布

- 主 Agent 内所有数据事实路径都先经过 release gate；semantic/records/trace 使用 scope、analysis ref 和 source revision 契约，旧数据工具或隐式 analytics/duplicate context 没有完整契约时在最终模型前失败关闭。
- 受治理回答在有界缓冲区生成；服务端逐个 uncited segment 校验 citation，拒绝未知/重复 tool-call ID、引用外事实和无证据因果，再决定是否释放 SSE。
- evidence gate 阻断时不调用最终模型；成文校验失败时丢弃全部模型原文，只发布稳定的受限答复和 machine-readable violation。
- 移除“流完以后自动补 citation”的伪修复；buffer 超限、timeout、registry 不可用全部 fail-closed。
- 无数据事实的 greeting/clarification 保持实时流式体验。

### 4. 本地 API 边界与可审计资格工件

- Node API 只绑定 `127.0.0.1`，严格校验 Host/Origin/port，CORS 不再使用 `*`。
- API POST 只接受 JSON，流式读取有明确上限并返回 413；transcribe 与 chat 使用同一认证链。
- 上游错误 body 不读取、不回显；客户端只收到稳定错误码。runtime 目录/文件强制 `0700/0600`，审计采用显式字段 allowlist 和 scope-bound opaque run/thread reference，不持久化 query text、客户端 run/thread ID、完整 actor scope、工具 input/output 或 stack；进程 metric 只记 query length。
- provider、客户端断连和 evidence block 都会形成唯一 machine-readable terminal audit；客户端写失败不能取消审计完成。
- qualification 命令实际运行 fixtures 与 Ontology gate，可选完整 Node suite/build；dirty checkout、失败 gate、commit/Ontology/fixture 漂移均不能通过 verify。
- 工件固定声明 `evidenceClass=deterministic_fixture`、`productionSnapshot=false`，避免把确定性 fixture 误报为模型准确率或生产效果。

## 仍需达到的目标能力

### P0 — 部署级身份与网络验收

代码分支完成的是应用层闭环，不等于已部署的企业 RLS。上线门槛应包括：真实 OIDC issuer/audience/JWKS、组织到 workspace/project/team 的受管映射、认证网关 TLS、数据源侧行/列策略、跨 scope 攻击用例、速率/并发限制和审计留存。远程访问不得直接暴露本地 Node/FastAPI 端口。

### P1 — 真实任务与策略 scorecard

建立 60–100 个经过业务负责人审核的 DTSV 任务，覆盖 aggregate、trend、rank、compare、trace、records drilldown、歧义、多轮澄清、空结果恢复、拒绝访问和 citation。每例绑定稳定 snapshot 或结果 invariant，并统计 task success、policy non-bypass、evidence validity、recovery、P50/P95、成本和人工 usefulness。当前 141 个 deterministic fixtures 是回归资产，不替代该 scorecard。

### P1 — 受治理关系执行适配器

一般跨实体分析只有在后端发布完整契约后才能启用。每条 runtime relationship 至少声明并双端校验：from/to entity 与 read model、approved path、join keys 与方向、metric grain/aggregate key、cardinality、fanout/explosion 策略、dimension/filter 可用性、scope/row-policy propagation、snapshot/revision compatibility、executor adapter/version。契约不完整或字段未物化时继续返回 clarification/422，不自动推断 join。

### P1 — 运行时韧性与生产可观测

增加跨进程 durable checkpointer、取消/超时/deadline 传播、幂等与 lease/fencing；将本地 append-only audit 接入 OTel/集中日志，建立错误率、拒绝率、证据阻断率、延迟、恢复率和 source freshness 的 SLO/告警。任何持久化状态继续以 actor scope 分区。

### P2 — 声明式分析体验

实现现有 `kpi`、`line`、`bar`、`grouped_bar`、`table` contract 的 renderer，并把 plan、scope 和 source revision 与可视化一起保存。自然语言修改图表时重新规划受治理 semantic frame，不允许浏览器直接篡改数据或执行任意 Python。

### P2 — 人审 Ontology 学习闭环

从脱敏失败 trace 中聚类缺口，生成变更提案、影响 goldens 和 owner；必须经过人工批准、compile、完整 scorecard、版本化发布与可回滚，完成前不称为 AutoUpdate。

## 对标方法

竞品应分为三组，避免类别错位：

1. 企业数据 Agent：Snowflake Cortex Analyst、Databricks Genie、ThoughtSpot Spotter 等，用于对标权限传播、评测、消费者 UX 和运营能力。
2. 语义与治理基础设施：Snowflake Semantic Views、Cube、dbt Semantic Layer/MetricFlow、Palantir Ontology 等，用于对标 metric contract、lineage、policy 和 change management。
3. 研究/构建参考：CHESS、MAC-SQL、LangGraph、Vanna 等，用于学习 schema linking、分解、恢复和 Agent loop，不直接作为产品成熟度排名。

公开比较必须给每个单元格记录产品版本、证据等级、原始链接、任务和通过阈值。商业产品的官方声明不能和本仓库 executable test 使用同一个无说明的 `✅/⭐`。

## 主要外部参考

- [Snowflake Semantic Views](https://docs.snowflake.com/en/user-guide/views-semantic/overview)
- [Snowflake Cortex Analyst Evaluations](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst-evaluations)
- [Databricks Genie quality tuning](https://docs.databricks.com/aws/en/genie-agents/tune-quality)
- [Databricks Genie monitoring](https://docs.databricks.com/aws/en/genie-agents/monitor)
- [Cube data access policies](https://docs.cube.dev/docs/data-modeling/data-access-policies)
- [dbt MetricFlow](https://github.com/dbt-labs/metricflow)
- [Palantir Ontology overview](https://www.palantir.com/docs/foundry/ontology/overview)
- [Palantir object permissioning](https://www.palantir.com/docs/foundry/object-permissioning/overview)
- [CHESS](https://github.com/ShayanTalaei/CHESS)
- [MAC-SQL](https://aclanthology.org/2025.coling-main.36/)
- [LiveSQLBench](https://github.com/bird-bench/livesqlbench)
- [Spider 2.0](https://github.com/xlang-ai/Spider2)
