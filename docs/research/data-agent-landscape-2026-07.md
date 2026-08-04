# 智能问数 / Data Agent 业界架构对标报告

> 调研日期：2026-07-29 · 覆盖 10 家大厂/商业产品、8+ 开源项目、6 个方法论专题
> 目的：与 Data-Agent 项目现状逐项对比，找出可借鉴/可直接抄袭的实现方案

---

## 一、大厂与商业产品怎么做

### 1.1 Uber QueryGPT（多 agent + RAG，迭代 20+ 版）
- **编排**：Intent Agent 路由到业务域 Workspace → Table Agent 选表（用户可改，人在环）→ Column Prune Agent 裁剪 200+ 列大表 → QueryGPT Agent few-shot 生成 SQL+解释
- **知识库**：向量库 KNN 检索 3 张表 + 7 条 SQL 样例；v1 直接对 schema 相似检索随规模失效，改为**先意图分类再检索**；system prompt 注入业务指令（日期口径、内部术语）
- **评估**：自建 eval 集（意图准确率、表重合度、可执行率、与 golden SQL 相似度）；写查询 10→3 分钟，月省约 14 万小时
- 来源：uber.com/blog/query-gpt

### 1.2 Pinterest（工程细节最实）
- **语义层**：无独立 semantic model，schema 含表/列描述 + **低基数列唯一值**（解决 `platform='web'` vs `'WEB'` 字面值映射）
- **RAG**：离线任务为表摘要+历史查询摘要建 OpenSearch 向量索引 → top-N 召回 → **LLM 精选 top-K** → 用户确认后生成 SQL；列按 tag 剪枝控 token
- **2026 升级版**：历史 SQL 先注入术语表/指标定义、转自然语言意图再向量化（"上下文-意图统一嵌入"）+ 治理感知排序（只索引高质量表）
- **runtime**：WebSocket 流式，LangChain partial JSON 边解析边回传
- **效果**：首发采纳率 20%→40%+，写 SQL 提速 35%
- 来源：medium.com/pinterest-engineering（Text-to-SQL 系列两篇）

### 1.3 Airbnb Minerva（指标中心制鼻祖）
- 12,000+ 指标、4,000+ 维度，**定义存 Git 仓库**，走 code review + 静态校验，"define once, use everywhere"
- 用户只表达"指标×维度"；Data API 用 split-apply-combine 把 derived metric 拆成 atomic 子查询再合并
- 来源：medium.com/airbnb-engineering（Minerva 系列）

### 1.4 LinkedIn SQL Bot（DARWIN 平台）
- LangChain/LangGraph 多 agent + validator + **self-correction agent**
- 表量数百万：**dataset certification**（专家填描述，AI 从文档和 Slack 讨论补全）；按组织架构推断用户关心的表；领域知识+查询日志+示例查询建**知识图谱**
- 人工评估 + LLM-as-judge；用户满意度 95%

### 1.5 Lyft ARIA / DoorDash Ask
- Lyft：LangGraph 编排 + SQL pipeline + 语义层（eng.lyft.com）
- DoorDash：**三层记忆**（离线长期/会话/显式 agent 记忆），向量检索后注入 prompt；**共享 MCP 工具层**；确定性操作不走 LLM；自动评估每日 2000+ 次模拟对话，回归 6h→20min（infoq.com/news/2026/07/doordash-ai-ask-assistant）

### 1.6 Databricks AI/BI Genie（语义容器设计范本）
- **Genie Space** = Unity Catalog 元数据（PK/FK、注释）+ knowledge store（表/列描述、**同义词**、带基数的 JOIN 关系、SQL 表达式 measure/filter、**值字典**）+ instructions + 示例 SQL；metric views 统一口径
- **check mode**：生成小 SQL 自校验（过滤值/日期窗/JOIN/聚合）；**trusted assets**（参数化查询命中即标 "Trusted" 徽章）
- 内置 benchmarks 功能做回归检测；行列权限经 Unity Catalog 继承

### 1.7 Snowflake Cortex Analyst（语义 YAML 可直接抄结构）
- YAML 语义模型：logical_tables、dimensions/time_dimensions/measures（expr、**synonyms**、default_aggregation）、relationships、**verified_queries**、custom_instructions
- **verified query 命中即短路 LLM**；Cortex Search 做字面值匹配；先返回 SQL 供展示再执行；多模型路由

### 1.8 Google Looker Conversational Analytics（最高准确率路线）
- **LLM 不直接写 SQL**——Gemini 只选字段/过滤/排序/limit，Looker 按 LookML **确定性组装查询**
- sample data（~100 值）+ fuzzy search 工具解析过滤值；Looker MCP server 把语义层暴露给外部 agent（PayPal 3000+ 用户）

### 1.9 ThoughtSpot Spotter
- **BARQ 架构**：NL 先翻译成受控 search token（关系搜索引擎词表）而非 SQL，再对语义模型校验；token 化中间表示天然可解释、可纠正
- HITL 反馈系统持续训练；Spotter 3 支持 Agentic MCP

### 1.10 横向规律
1. **语义层是准确率第一杠杆**：面向业务用户的问数，头部全部走"指标/语义模型前置"（Airbnb/Snowflake/Looker/ThoughtSpot）
2. **确定性中间层成主流**：NL→DSL/token/measure 选择，由引擎生成 SQL，避免 LLM 直接写 SQL
3. **多 agent 分工趋同**：意图路由→选表→列剪枝→生成→校验自愈
4. **MCP 正成为工具层标准**（DoorDash/Databricks/Looker）
5. **值映射**靠低基数值字典+模糊搜索；业务术语靠同义词注入
6. 权限下沉到引擎层 RBAC/行列级安全，不信任 prompt

---

## 二、开源项目怎么做

### 2.1 Vanna（RAG 经典范式）
- 0.x：**DDL/文档/问-SQL 三类语料分开建索引分开检索**，拼 prompt 一次生成；用户确认后回流 training data
- 2.0（2025）：改为 Agent + ToolRegistry，**user-aware tool**（权限在 tool 层强制）
- 可抄：三分法索引；正确结果回流成 few-shot 库
- github.com/vanna-ai/vanna

### 2.2 WrenAI（语义层+显式 pipeline，与你们架构最像）
- pipeline 显式分步：intent classification → schema retrieval（Qdrant，存 MDL 列/表描述 embedding）→ SQL generation（基于 MDL 而非裸 DDL）→ **correction 循环**（引擎 dry-run，结构化错误+hint 回喂 LLM 重写）
- **MDL**（JSON/YAML）：models/columns/relationships/metrics/views/RLAC，引擎把语义编译成物理 SQL
- 可抄：LLM 只面对逻辑层，join/metric 由引擎编译；dry-plan 结构化错误作为纠错信号；MDL 存 git 可评审可 diff
- github.com/Canner/WrenAI

### 2.3 XiYan-SQL（当前 SOTA，BIRD 75.63%）
- M-Schema 半结构化表示 → 候选双路生成（SFT 模型 + ICL，**NER-based few-shot 选择**）→ Refiner 逐候选纠错 → **Selection model 在候选间选最优**
- 可抄：**多候选+判别器选择**（比单次生成高 5-10 个点）；schema 描述自动生成器（DBDescGen）做冷启动
- github.com/XGenerationLab/XiYan-SQL

### 2.4 LangGraph 官方 SQL agent（与你们同框架，直接可抄）
- 3 工具：`list_tables`（无参）→ `get_schema`（表名→DDL+3 行样本）→ `query`；图**强制顺序**（tool_choice 约束）
- `check_query` 节点按 **8 类常见错误清单**复审（NOT IN+NULL、UNION vs UNION ALL、BETWEEN 边界、类型不匹配…）→ 错误作为 observation 回流重试；可插 interrupt 人工审批
- 可抄：关键步骤用图强制而非 prompt 祈祷；check_query 错误清单 prompt 原文可用

### 2.5 Google MCP Toolbox for Databases（工具标准化）
- tools.yaml 四层：source（连接池）→ tool（**参数化模板 SQL**，$1 占位防注入）→ toolset（按角色分组下发）→ prompts
- 可抄：SQL 工具=参数化模板而非自由 SQL；toolset 按角色下发；声明式 YAML 即工具注册表
- github.com/googleapis/genai-toolbox

### 2.6 DB-GPT / sqlcoder（参考）
- DB-GPT：AWEL 用 DAG 显式声明多 agent 数据流；微调+RAG 双轨
- sqlcoder：**按 6 类问题（date/group_by/order_by/ratio/join/where）做分类准确率报表**；训练/评测 schema 严格隔离

### 2.7 语义层开源（Cube / dbt MetricFlow）
- Cube：对 agent 暴露 **Meta API**（模型自省）+ MCP server；访问策略在语义层确定性强制
- MetricFlow：semantic models（entities=join key、dimensions、metrics）YAML，编译器在语义图上找 join 路径

### 2.8 开源界共识 TOP10
1. 语义层优先于裸 DDL，LLM 面对逻辑层
2. 多候选生成+判别器选择
3. 三类语料分库检索（schema/术语/Q-SQL）
4. 执行即反馈：dry-run 先行，结构化错误回流，限 2-3 轮
5. 确定性步骤用图强制，只有生成/修复环节是 agentic
6. 危险操作双闸：prompt 禁 DML + 执行层只读/参数化
7. 正确结果回流成 few-shot 库
8. 权限在工具/引擎层强制
9. 工具即契约：强 schema + 面向 LLM 选择的 description
10. 按问题类型建评测，训练/评测隔离

---

## 三、方法论共识（六专题）

| 专题 | 共识结论 |
|---|---|
| 语义层 | 趋势是 NL2MQL2SQL：LLM 生成声明式意图（指标×维度×过滤），编译层产 SQL。BIRD 上有无外部知识差 20pp。语义定义走 Git 版本化 |
| 编排 | 主流是**结构化状态机工作流**（步骤固定、步内 LLM 决策、条件路由纠错），非自由 ReAct；混合架构=全局 plan-execute+步内轻量 ReAct；HITL 用 interrupt+checkpoint |
| Runtime | 短期记忆=checkpointer（生产 Postgres），长期记忆=store；上下文压缩=trim+SummarizationMiddleware；流式按节点边界发事件 |
| 工具 | 收敛为五段：发现(schema/指标)→生成→校验(dry-run)→执行→呈现；结果截断=上下文预算显式设计；混合检索（向量+BM25→RRF→rerank） |
| 评估 | 执行准确率(EX)为主；Spider 已饱和、Spider 2.0 上 GPT-4o 仅 10.1%——**必须自建 100+ 真实业务问题回归集**；在线失败归因回流 |
| 治理 | "Security must never be enforced by the LLM"——行列权限在 SQL 编译期注入，agent 构造不出越权查询；全链路审计 |

---

## 四、Data-Agent 现状 vs 业界逐项对比

| 维度 | 业界主流做法 | 你的现状 | 差距 |
|---|---|---|---|
| **语义层** | YAML/MDL 语义模型，同义词+verified queries+值字典，Git 版本化 | **自研 ontology 9 类 schema + 编译器 + vocab.zh-CN 词表**——方向与 Snowflake/Cube 一致，属于**领先项** | 🟢 强（缺 verified queries、值字典） |
| **编排** | 状态机工作流：意图→选表→剪枝→生成→校验纠错回路 | LangGraph StateGraph + IntentRouter + ToolPlanning，已是状态机 | 🟢 对齐（缺纠错回路） |
| **Agent runtime** | Postgres checkpointer + store 双层记忆 + interrupt HITL + 上下文压缩 | **MemorySaver（重启即丢）**，无 store，无压缩 | 🔴 弱 |
| **工具调用** | 五段收敛+参数化模板+MCP 标准化+工具层权限 | 20 个工具+registry+policy gate，但无 MCP、自由 SQL | 🟡 中 |
| **知识库/RAG** | 三类语料分库向量检索+意图先行+值字典+同义词 | **RAG 在迁移中丢失**（死代码），无语义检索 | 🔴 弱 |
| **SQL 生成** | 多候选+判别器（SOTA）或语义编译（企业级）+check_query 清单 | 单次生成，无自纠错 | 🔴 弱 |
| **数据库** | 引擎层编译+dry-run+只读账号+行列权限编译期注入 | DuckDB+FastAPI 分析后端，policy gate 在 prompt 层 | 🟡 中 |
| **评估** | 100+ 真实问题 golden 集+EX 指标+分类报表+在线回流 | evals/ 仅 1 个 jsonl | 🔴 弱 |
| **图谱可视化** | （差异化方向，业界少见） | ontology 图原型已有，规划实例级 KG | 🟢 差异化 |

---

## 五、可直接抄袭清单（按性价比排序）

### P0 — 本周可做（低成本高收益）
1. **check_query 错误清单**（抄 LangGraph 官方）：生成后加校验节点，8 类错误 prompt 复审，错误回流重试 ≤3 轮。1 个图节点的事
2. **MemorySaver → SqliteSaver/PostgresSaver**：LangGraph 官方包，换 checkpointer 实例即可
3. **Verified queries 机制**（抄 Snowflake/Databricks）：ontology 增加"已验证问题→标准答案"映射，命中即短路 LLM 并标"可信"徽章——准确率瞬间提升且零模型成本
4. **值字典**（抄 Pinterest/Genie）：低基数列的唯一值离线导出存 ontology，`platform='web'` 类字面值错误直接消失

### P1 — 两周内（结构性补强）
5. **三类语料分库 RAG**（抄 Vanna）：schema 描述/业务术语(vocab 已有)/问题-SQL 对，分开向量化分开检索；sentence-transformers 已在依赖里
6. **意图先行检索**（抄 Uber）：IntentRouter 已有，把"先分类再检索"接到 RAG 前面
7. **dry-run 结构化纠错**（抄 WrenAI）：执行前 EXPLAIN/dry-run，错误码+hint 结构化回喂，限 2-3 轮
8. **工具五段收敛+YAML 注册表**（抄 MCP Toolbox）：20 个工具按发现→生成→校验→执行→呈现归类，拆 1772 行大文件，SQL 工具改参数化模板
9. **interrupt 人工审批**（LangGraph 原生）：高风险查询执行前挂起确认

### P2 — 一个月内（冲击高准确率）
10. **NL2MQL2SQL**（抄 Looker/Minerva/WrenAI）：LLM 不直接写 SQL，输出"指标×维度×过滤"声明式意图，ontology 编译器产 SQL——这是面向业务用户的最高准确率路线，你们的 ontology 已具备所有原料
11. **私有回归集**：100+ 真实业务问题+golden 答案，按 date/join/ratio/group_by 分类报表，每次改语义层/工具后跑
12. **长期记忆 store**（抄 DoorDash 三层记忆）：用户偏好/口径修正跨会话记住
13. **正确结果回流**：用户确认/点赞的查询自动进 few-shot 库（Vanna 模式）

### P3 — 远期（SOTA 选项）
14. **多候选+判别器选择**（抄 XiYan-SQL）：n=3 候选并行生成，refiner 修，selection 挑——BIRD 涨点主力，成本翻倍
15. **MCP 工具层**：对内把 ontology/分析工具暴露成 MCP server，对外接现成工具生态
16. **混合检索 RRF+rerank**：向量+BM25 融合后精排（schema 量大后再上）

---

## 六、结论

你们的**架构判断是对的**：LangGraph 状态机 + 自研 ontology 语义层，与业界收敛方向（WrenAI/Snowflake/Cube 路线）一致，ontology 甚至是差异化资产。

真正弱的四件事全部有现成答案：**runtime 持久化**（换 checkpointer）、**RAG 检索**（抄 Vanna 三分法+Uber 意图先行）、**自纠错**（抄 check_query+dry-run）、**评估**（自建 golden 集）。这四件做完，准确率可从"演示级"进入"生产级"区间（业界经验：采纳率 20%→40%+）。

最高杠杆的一步是 P2-10（NL2MQL2SQL）：ontology 从"给 LLM 看的上下文"升级为"编译目标"，LLM 只做选择题不做作文题——这是 Looker/Snowflake/ThoughtSpot 三家殊途同归的结论，也是你们 ontology 投资的回报最大化路径。
