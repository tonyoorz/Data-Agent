# Vizion Lab 数据 Agent · 七维差距分析

> 审计日期：2026-07-30 ｜ 对标：Snowflake Cortex Analyst / Databricks Genie / dbt Semantic Layer / Palantir AIP / Vanna 2.0
> 所有结论基于代码库实读，均附文件路径证据。本文按你提出的 7 个维度组织，与已有的 `docs/vizion-maturity-gap-analysis.html`（按优先级组织）互为补充。

---

## 0. 先纠正一个前提：你做的不是"全网数据 Agent"

在逐项分析前必须点明定位，否则第 1 维的对标会完全跑偏。

**Vizion Lab 是一个垂直领域、单一权威源、强治理的缺陷分析 Agent**，不是通用检索 Agent。代码事实：

- 唯一外部数据源是 Octane（`backend/analytics/ingest/client.py:144`，基址 `octane-prod.bmwgroup.net`，`config.py:116`）
- 全仓库无任何 web search 集成（无 google / bing / tavily / serpapi / duckduckgo 依赖）
- `ontology/v1/sources.json` 声明的 16 个 source **全部**指向本地 `database/source/qgate_raw.db`，是 Octane 的衍生表

这不是缺陷，是**正确的架构选择**。企业级数据 Agent（Cortex、Genie、AIP）同样刻意不做全网检索——数据可信度和治理边界比覆盖面重要得多。所以下面第 1 维我按**"权威源覆盖度 + 时效性"**来评，而不是按"全网覆盖率"。如果你确实想做通用全网 Agent，那是另一个产品，当前架构（本体契约 + allowlist SQL）需要推倒重来，我建议不要。

---

## 成熟度总览

| # | 维度 | 现状 | 企业基线 | 差距 |
|---|---|---|---|---|
| 1 | 权威源覆盖 / 准确性 / 时效性 | 5.5 / 9 | 混合检索已达标，时效靠轮询 | 中 |
| 2 | 多源异构整合与冲突消解 | 3 / 9 | 单源，无跨源实体解析 | **大** |
| 3 | 意图理解与自然语言交互 | 4 / 9 | 正则分类，源码缺失 | **大** |
| 4 | 数据安全 / 权限 / 合规 | 4.5 / 9 | 本体层强，网关层裸奔 | **大（P0）** |
| 5 | 可扩展性与高并发 | 1.5 / 9 | 单进程 + 裸 SQLite | **极大（P0）** |
| 6 | 错误恢复与容错 | 3 / 9 | 局部重试，无熔断 | 中大 |
| 7 | 结果质量评估与排序 | 4.5 / 9 | 查重侧强，主链路无评测 | 中大 |

**一句话结论**：你的**本体/语义契约层**（28 实体 / 50 维度 / 30 指标 + 指纹校验 + actorScope 行列级策略 + 敏感字段脱敏）做到了很多商业产品的水平，是真正的差异化资产；**查重检索**（TF-IDF + bge 向量 + RRF 融合 + 三阶段渐进式 reranker + 反馈重训）也超出原型水准。但从"能跑"到"企业级"的分水岭卡在三处：**网关无身份认证、单进程裸 SQLite 无法并发、核心 Python 模块只有字节码没有源码**。

---

## ⚠️ 一个必须先处理的问题：`agent/` 目录源码丢失

```
find agent -name "*.py" | wc -l   →  0
find agent -name "*.pyc" | wc -l  →  50
```

`agent/understand/`（intent_detector、entity_extractor、term_resolver）、`agent/sql_engine/`、`agent/learning/`（feedback_store、semantic_matcher、query_memory）、`agent/ontology/`（engine、reasoning、alignment、governance、rag、profiler）**全部只剩 `__pycache__` 里的 .pyc 字节码，没有任何 .py 源文件**。

这意味着：意图检测、实体抽取、术语解析、SQL 引擎这些最核心的逻辑**无法审计、无法修改、无法评审**，且一旦 Python 小版本升级（当前混杂 cpython-312 和 cpython-313 两套字节码）就会直接失效。

**这比本文任何一条技术差距都严重。** 企业级 Agent 的第一前提是可审计。请先确认：这些源码是被 `.gitignore` 误伤、被清理脚本删除，还是还在别的分支/机器上。如果真的丢了，用 `decompyle3` / `pycdc` 反编译抢救，然后立刻纳入版本控制。

---

## 维度 1 · 权威源覆盖范围、准确性与时效性

### 现状（有证据）

**检索链路实际上做得不错**，这是项目的强项之一：

- **混合召回**：TF-IDF（char_wb，3-5 gram，`duplicate_issue_finder.py:770`）+ 稠密向量（`BAAI/bge-small-zh-v1.5`，`:32`；可切远程 `qwen3-embedding-8b`，`:61`）
- **RRF 融合**：`_fuse_ranked_lists_rrf`，K=60（`:894`）——这是正确做法，比加权求和更鲁棒
- **三阶段渐进式重排**：`progressive_reranker.py` 的 click_boost → logistic feature → contrastive adapter，且带 `ModelSafetyGuard` nDCG 护栏防止重训劣化
- **时效性追踪**：`semantic_query.py:142` `_source_freshness_warnings` 有 SLO + watermark 机制；`dashboard_snapshot.py:37` 用文件 mtime 生成 snapshot_version
- **增量同步**：`pipeline.py:160` 按 `last_modified` 水线拉取，带 3 天重叠窗口（`:17`）防止边界丢数据

### 差距

| 问题 | 证据 | 企业级做法 |
|---|---|---|
| 向量检索是内存全量点积 | numpy 矩阵 + SQLite `ticket_embeddings.db`（`:217`），无 FAISS/HNSW | 万级以上必须 ANN 索引，否则 QPS 随数据量线性劣化 |
| 无相似度阈值截断 | topK 固定 10（`:979`），无 min_score | 低质量结果强行凑满 10 条，污染 LLM 上下文 |
| 部分源水线硬编码 `unknown` | `semantic_query.py:607/626/691`（test_runs / testcases） | 这些源**永远不会触发新鲜度告警**，静默过期 |
| 轮询而非 CDC | `last_modified` 轮询 | Debezium / Octane webhook，秒级而非小时级 |
| embedding 缓存不随模型失效 | 仅按 `text_hash`（`:251`） | 换 embedding 模型后会命中旧向量，静默污染检索 |

### 改进建议

1. **P0 · 修复 embedding 缓存键**：`cache_key = hash(text + model_name + model_revision)`。这是个静默正确性 bug，改动 5 行，收益极大。
2. **P0 · 补齐 test_runs / testcases 的 watermark**：从实际数据 `MAX(updated_at)` 取，别写死 unknown。
3. **P1 · 引入 ANN 索引**：`hnswlib`（纯本地、无服务、pip 装完即用，比引 Qdrant 轻得多）。10 万条以内召回率 >0.99，延迟从 O(n) 降到 O(log n)。
4. **P1 · 加自适应截断**：保留 `score > μ + 0.5σ` 或 RRF 分数断崖处截断，宁可返回 3 条也不要凑 10 条。
5. **P2 · Octane webhook 增量**：把小时级轮询降到分钟级，同时保留轮询做兜底对账。

---

## 维度 2 · 多源异构数据整合与冲突消解

### 现状

三层数据流转是清晰的：`source(qgate_raw.db)` → `hot(dashboard_ticket_snapshot_*, read_models.py:1390)` → `cold(cold_archive.py:120, DuckDB + Parquet)`。

已有的冲突处理：
- 主键幂等：`ON CONFLICT DO UPDATE`（`source_store.py:442`）
- 维度保护：`_preserve_dimension`（`:256`）——新值为 unknown 时保留旧值
- 字段映射：`processor.py:73/256` 做 Octane UDF → 标准 project 的映射并打 conflict 标记

### 差距（这是最大的短板）

**根本问题：只有一个源，所以"多源异构整合"这个能力从未被真正实现过。** `_preserve_dimension` 是"字段级空值兜底"，不是冲突消解；`processor.py` 的 conflict 只**标记不合并**，下游没有任何消费方处理这个标记。

具体缺失：

- **无实体解析（Entity Resolution）**：没有跨源的 `same_as` 判定、没有阻塞键（blocking key）、没有相似度匹配后的实体合并。今天接入第二个源（比如 Jira 或 SAP），系统会把同一个缺陷当成两条完全独立的记录。
- **无冲突消解策略**：企业级至少要有可配置的优先级规则——source priority（哪个系统对哪个字段权威）、recency（最近更新胜出）、confidence-weighted（按数据质量分加权）、以及无法自动裁决时的人工仲裁队列。你一条都没有。
- **无 Schema 演化处理**：Octane 加个字段或改个枚举，`processor.py` 的硬编码映射会静默丢数据，没有 schema drift 检测。
- **cold archive 是整表快照**：`cold_archive.py:120` 无分区、无生命周期策略，长期会膨胀。

### 改进建议

1. **P1 · 先把冲突模型定义出来**（哪怕只有一个源）。在 ontology 里为每个字段声明 `authority: {source, priority, strategy}`，strategy ∈ `{source_priority, latest_wins, max_confidence, manual}`。这是纯声明式改动，为未来接第二个源铺路。
2. **P1 · 让 conflict 标记可消费**：`processor.py` 打的标记要暴露到 `quality.conflicts` 字段，让 Agent 在回答时能说"该字段存在跨源冲突，当前采用 Octane 值"。**能承认不确定性的 Agent 才是可信的 Agent。**
3. **P1 · 加 schema drift 检测**：摄取时对比 Octane 返回的字段集与 `octane_field_catalog.py` 的已知集，新增/消失字段直接告警而不是静默忽略。
4. **P2 · 实体解析骨架**：`entity_resolution.py`，输入多源记录 → 阻塞键（如 title 的 minhash + 时间窗）→ 候选对 → 相似度打分 → 合并/存疑队列。你已经有向量和 TF-IDF 能力，复用即可。
5. **P2 · cold archive 按 `year/month` 分区** + 保留策略。

---

## 维度 3 · 用户意图理解与自然语言交互

### 现状

运行时是 LangGraph `StateGraph`（`server/agentRuntime/langGraphChatRuntime.mjs:534`），节点链路：
`initialize → resolve_context → route_tools → plan_tool_calls → execute_tool_calls → finalize`

- **工具**：21 个（`mainAgentTools.mjs:162`），按 14 个意图档分组（`mainAgentToolRegistry.mjs` `MAIN_AGENT_INTENT_PROFILES`）
- **循环控制**：`maxToolSteps = 4`（夹紧 1–10），每轮最多 3 个工具调用（`mainAgentToolOrchestrator.mjs:152`）
- **澄清机制**：有 `ask_clarification` 工具 + `requiresUserInput → clarification_requested` 中断（`:68`），指标歧义时 `ontology/resolver.mjs` `buildFocusedClarification` 会追问 —— **这点做得比多数原型好**
- **上下文管理**：`chatMessageBudget.compactChatMessages` 按 24000 字符预算压缩，分组保留 tool 调用完整性
- **NL2SQL**：**刻意不做自由文本 SQL**。LLM 只能产出结构化契约（`intent/metricIds/dimensionIds/filters/timeScopes`），经 `_validate_request` 强校验（ontology 指纹比对 + operator 白名单 + metric-dimension 绑定），后端从 allowlist 生成 SQL。`fallback_query.py:238` 直接拒绝 raw SQL。

**这个"结构化契约替代裸 SQL"的设计是对的**，Cortex Analyst 走的也是同一条路（生成针对受治理语义模型而非裸 schema），这正是它能到 90%+ 准确率的原因。

### 差距

| 问题 | 证据 | 影响 |
|---|---|---|
| **意图分类是纯正则** | `routeToolIntent`（`mainAgentToolRegistry.mjs:111`），14 类，confidence 是**静态硬编码**的 0.5–0.9 | 长句、口语、多意图复合句必然误判；confidence 完全无意义，不反映真实把握 |
| `requiredSlots` 声明了但不强制 | 同上 | 槽位缺失时不触发澄清，直接带着空槽跑下去 |
| **指代消解不可审计** | `agent/understand/` 只有 .pyc | 「那个缺陷」「上面那个团队」能不能解析，无从得知 |
| 无模型兜底路由 | 无 fallback classifier | 正则全不命中时的降级路径不明确 |
| 工具串行执行 | `for...await executeOne`（`:444-459`） | 3 个独立查询本可并行，延迟直接 ×3 |

### 改进建议

1. **P0 · 正则 + LLM 双层路由**：正则命中且模式强（如精确关键词）走快路径；未命中或弱命中降级到一次小模型分类调用，输出**真实 confidence**。低于阈值（如 0.6）强制触发 `ask_clarification`。这一步能把意图准确率从"不可知"变成"可度量"。
2. **P0 · 强制 slot filling**：`requiredSlots` 缺失 → 直接进澄清分支，不进工具循环。你已经有澄清中断机制，只是没接上。
3. **P1 · 工具并行化**：`executeOne` 改成对无依赖的 tool call 用 `Promise.allSettled` 并发。改动小、体感提升最明显。
4. **P1 · 上下文压缩改语义摘要**：24000 字符硬截断会丢关键早期约束。改成"最近 N 轮全文 + 更早轮次 LLM 摘要 + 固定的实体/约束栈"。
5. **P2 · 建意图误判回流**：用户点"这不是我要的" → 记录 (query, routed_intent, correct_intent) → 定期喂给正则规则修订或小模型微调。

---

## 维度 4 · 数据安全、权限管控与合规性

### 现状：本体层很强，网关层裸奔

**做得好的部分（真的好）**：
- 行级权限：`semantic_query._validate_actor_scope` 强制注入 `workspaceIds / projectIds / teamIds / rowPolicyIds` 过滤
- 列级权限：`allowedPropertyIds / sensitiveFieldPolicyIds` 白名单
- 敏感字段脱敏：`_redact_sensitive_dimensions`（`:695`）做 sha256 假名化
- 只读约束：`analytics.read_only` 策略校验 `_query_operation ∈ allowedOperations`（`:328`）
- 审计：`runtimeAuditStore.mjs` 写 `tool-calls.jsonl` + `run-events.jsonl`，含 actorScope / toolName / input / output

**致命缺口**：

```
grep -rln "Authorization|rate.limit|jwt|oauth" server/*.mjs backend/analytics/*.py
→ chatModelConfig.mjs, imageOcr.mjs, transcribe.mjs   （全是「出站」调外部模型 API 用的）
```

**入站方向零认证。** `server/index.mjs` 只有 CORS（且是 `*`），FastAPI 无中间件、无 `Depends`、无 `HTTPBearer`。

而最要命的是：**`actorScope` 是从请求体里读的，调用方自报家门。** 这意味着上面那套精心设计的行列级权限，任何人构造一个 `{"actorScope": {"projectIds": ["*"]}}` 的 POST 就能全部绕过。**安全模型在此处完全失效。**

### 差距

| 问题 | 风险 |
|---|---|
| 入站无认证 + CORS `*` | 未授权访问全量缺陷数据、模型额度被刷爆 |
| actorScope 请求体自报 | 行列级权限形同虚设 |
| 无限流 | 单个客户端可打满 LLM 预算 |
| 审计日志是本地明文 JSONL | 可篡改、可删除，不满足合规取证要求 |
| 无 PII 自动检测 | 仅靠 ontology 人工标注，漏标即泄露 |
| 无数据保留/删除策略 | GDPR「被遗忘权」无法执行 |

### 改进建议

1. **🔴 P0 · 立刻把 actorScope 绑定到已认证身份**。加 JWT/OIDC 中间件，`actorScope` **只能**从 token claims 推导，请求体里的同名字段直接丢弃。这一条不做，第 4 维其余全是装饰。
2. **🔴 P0 · CORS 收紧到已知 origin + 加限流**（Node 侧 `express-rate-limit` 或手写令牌桶；Python 侧 `slowapi`）。
3. **P1 · 审计日志防篡改**：每条记录带前一条的 hash（哈希链），或直接写到 append-only 存储。合规审计的基本要求。
4. **P1 · PII 自动扫描**：摄取阶段跑一遍正则 + NER（邮箱/工号/姓名/IP），发现未标注的敏感字段就告警，别只依赖人工标注。
5. **P2 · 数据保留策略**：在 ontology 里声明每类数据的 TTL，配套自动清理任务。

---

## 维度 5 · 可扩展性与高并发处理能力

### 现状：这是全部七维里最弱的一项

代码事实（都很短，因为确实什么都没有）：

```js
// server/index.mjs:287
const server = http.createServer(async (request, response) => { ... });
server.listen(port);          // 单进程，无 cluster，无 worker_threads
```

```python
# backend/analytics/db.py:7-11
def connect(db_path):
    conn = sqlite3.connect(path)   # 无 WAL、无 timeout、无连接池
    conn.row_factory = sqlite3.Row
    return conn
```

```js
// scripts/dev.mjs:129 —— uvicorn 启动参数里没有 --workers
args: ["-m", "uvicorn", "backend.analytics.api:app", "--host", "127.0.0.1", "--port", ...]
```

### 差距

| 问题 | 后果 |
|---|---|
| **SQLite 默认 journal 模式（非 WAL）** | 写锁阻塞所有读。摄取任务一跑，全站查询 hang 住 |
| **无 `busy_timeout`** | 并发写立即抛 `database is locked`，不是等待重试 |
| 单 uvicorn 进程 | Python GIL + 单 worker，CPU 密集的 embedding 计算会阻塞整个 API |
| 单 Node 进程 | 一次未捕获异常 = 全站挂掉 |
| **向量索引常驻内存且全量点积** | 内存随数据线性增长，多进程部署时每个进程一份副本 |
| **`MemorySaver` 会话状态在进程内存** | 重启即丢全部会话；且天然无法水平扩展（请求必须粘同一进程） |
| 无 Redis / 分布式缓存 | `_summary_cache`（`dashboard_snapshot.py:12`）是进程内字典**且无失效机制** |
| 无队列 | 长任务（摄取、重训、报告生成）与在线请求抢同一进程资源 |

**结论**：当前架构的并发上限大约是**个位数并发用户**，且写入期间会退化到基本不可用。这是"本地单机工具"的架构，不是"企业级服务"的架构。

### 改进建议（按性价比排序）

1. **🔴 P0 · 三行代码换十倍并发**：
   ```python
   conn.execute("PRAGMA journal_mode=WAL")
   conn.execute("PRAGMA busy_timeout=5000")
   conn.execute("PRAGMA synchronous=NORMAL")
   ```
   WAL 让读写不互斥，这是 SQLite 并发的最大单点改进，**改动成本几乎为零**。
2. **🔴 P0 · uvicorn 加 `--workers 4`**，同时确认所有 SQLite 连接是 per-request 创建而非全局共享。
3. **P1 · 会话状态换持久化 checkpointer**：`MemorySaver` → `SqliteSaver`（LangGraph 官方支持，改动约 10 行）。这同时解决"重启丢会话"和"无法水平扩展"两个问题。
4. **P1 · `_summary_cache` 加 TTL + 容量上限**（简单 LRU 即可），现在它是个只增不减的内存泄漏。
5. **P1 · Node 加 `cluster` 多进程** + 未捕获异常兜底（`process.on('uncaughtException')` 记录后优雅退出，由 supervisor 拉起）。
6. **P2 · 长任务拆到独立进程/队列**：摄取、reranker 重训、报告生成走单独 worker，别和在线请求抢资源。
7. **P2 · 明确扩容路径**：SQLite 撑不住时迁 PostgreSQL（读写分离 + 连接池），向量迁 pgvector 或独立 Qdrant。**现在不必做，但要提前把 DB 访问收敛到一层抽象**，避免将来散落各处的 `sqlite3.connect` 需要逐个改。

---

## 维度 6 · 错误恢复与容错机制

### 现状

已有的容错是**局部且不均衡**的：

- ✅ 查重桥有完整重试：`duplicateBridgeRuntime.cjs` `_sendWithRetry` + `isRetryableBridgeError` + 超时 45s/180s（`:98-148`）
- ✅ 工具规划失败有降级：`index.mjs:150-156` 回退到"用已检索上下文回答"
- ✅ 伪工具调用兜底：`companyChat.mjs:307` `PSEUDO_TOOL_FALLBACK`
- ✅ 空结果自动诊断重试：`diagnose_analytics_empty` + `buildEmptyDiagnosisToolCall`（这个设计很聪明）
- ✅ ASR/OCR/PDF 都有超时
- ✅ FastAPI 端点有结构化异常（503/400/409）

### 差距

| 问题 | 证据 |
|---|---|
| **analytics 工具调用只标记 retryable 但不真重试** | `mainAgentTools.mjs:1009` —— 标了 `retryable: true` 然后什么也没做 |
| **无熔断器** | 全仓无 circuit breaker。Octane 或模型 API 挂了，每个请求都要等满超时才失败，线程池被拖垮 |
| **LLM 调用无 deadline** | 模型端 hang 住 → 请求无限挂起 |
| 无退避抖动 | 仅查重桥有重试，且无 jitter，故障恢复时会造成惊群 |
| 后端无重试、无限流 | FastAPI 侧完全裸奔 |
| 无幂等键 | 重试可能导致重复写入（尤其 `duplicate_comment_writer` 这种会回写 Octane 的操作） |
| 无健康检查/自愈 | `dev.mjs` 有 `isHealthy` 探测，但只在启动时用，运行期无持续探活 |

### 改进建议

1. **🔴 P0 · 给所有出站调用套统一的 deadline**：LLM、Octane、analytics HTTP 全部用 `AbortSignal.timeout(ms)` 包裹。无超时的外部调用是生产事故的头号来源。
2. **P0 · 把 `retryable: true` 兑现**：写一个通用 `withRetry(fn, {retries: 3, backoff: exponential, jitter: true, retryOn: isRetryable})`，统一套到 analytics 和 LLM 调用上。
3. **P1 · 加熔断器**：对 Octane / 模型 API 各维护一个断路器（连续 5 次失败 → 打开 30s → 半开试探）。`opossum` 库开箱即用，或手写 40 行。熔断打开时直接返回友好降级信息，别让用户等 45 秒。
4. **P1 · 写操作加幂等键**：`duplicate_comment_writer` 回写 Octane 时带 `idempotency_key = hash(defect_id + comment_hash)`，服务端或本地去重表拦截重复。
5. **P1 · 错误分类法**：定义 `intent_misroute / tool_blocked / empty_result / model_error / timeout / auth_denied / data_stale` 七类，所有异常归类后打点。没有分类就无法知道"到底什么在坏"。
6. **P2 · 运行期健康探测 + 自愈**：复用 `dev.mjs` 的 `isHealthy`，做成周期性探活，子进程死了自动重启。
7. **P2 · 会话级 checkpoint 恢复**：LangGraph 已有 checkpointer，配合 P1 的 SqliteSaver，可实现"工具执行中途崩溃后从断点续跑"，而不是整轮重来。

---

## 维度 7 · 检索结果的质量评估与排序优化

### 现状：查重侧强，主链路空白

**查重侧（相当成熟）**：
- 三阶段渐进式 reranker，按反馈量自动升级：click_boost（≥0）→ logistic feature（≥50）→ contrastive adapter（≥200），`RETRAIN_INTERVAL=20`（`feedback_store.py:51-70`）
- `ModelSafetyGuard` 用 nDCG 做护栏，重训后指标劣化则回滚
- 反馈信号完整：positive / negative / click，带速率限制（50/h）和翻转窗口（300s）防刷
- 有离线评测模块 `duplicate_search_eval.py`（nDCG/MRR）

**主分析链路（几乎空白）**：
- `mainAgentEvidence.mjs` `buildToolEvidence` 抽取 `ontologyVersion / schemaFingerprint / sourceRevision / quality / limitations / url`
- `semantic_query` 返回 `quality.completeness / missingness / truncated / warnings`（`:772-779`）

### 差距

| 问题 | 说明 |
|---|---|
| **证据是"来源元数据"而非"答案溯源"** | 知道数据来自哪个 revision，但不知道**答案里的这个数字**是哪一行算出来的 |
| **无答案级置信度** | 意图 confidence 是静态硬编码值，不是真实把握度 |
| **无事实一致性校验** | LLM 完全可能在有正确数据的情况下把数字说错，无任何校验 |
| **无执行级评测** | 113 例 golden 只校验语义帧（意图/指标/维度解析对不对），**从不校验返回的数据行是否正确** |
| **无 CI 回归** | `.github/workflows/` 不存在。任何改动都可能静默破坏准确率 |
| **反馈闭环只服务查重** | 主 Agent 的回答质量、意图路由、工具选择完全没有反馈信号 |
| `duplicate_search_eval.py` 只被单测用合成数据调过 | 有评测代码但没有真实评测基线 |

### 改进建议

1. **🔴 P0 · 建结果集级 golden set**：20–50 个真实业务问题 + 期望结果行。对比方式参考 Genie：**比对结果集而非文本**，接受不同排序，数值取 4 位有效数字相等。这是"知道自己准确率是多少"的唯一途径。
2. **🔴 P0 · 加 CI**：GitHub Actions 跑 `npm test` + `pytest` + golden 结果集对比，准确率跌破阈值直接 fail。你已经有 `test:ontology` 这类脚本，接上去成本很低。
3. **P1 · 数值锚定校验**：回答生成后，抽取其中所有数字，逐一在工具返回的结果集中查找。找不到的数字 → 标记为"未经验证"或直接重新生成。这是防 LLM 数值幻觉最有效的手段，实现成本远低于想象。
4. **P1 · 真实置信度**：综合意图分类置信度、检索得分分布（top1 与 top2 的间隔）、数据完整性 `quality.completeness`、是否触发降级路径，输出一个真实的 0–1 分数。低置信时主动说"我不太确定，建议核对"。**Agent 的可信度来自它承认不确定的能力。**
5. **P1 · 把反馈闭环扩展到主链路**：`/api/chat-feedback` 收 👍/👎 + 可选的"哪里错了"（意图错/数据错/表述错）→ 分别回流到意图路由修订、golden set 扩充、prompt 调优。你已经有 `build_eval_cases_from_feedback`，接上即可。
6. **P2 · 句子级引用标注**：回答里每个论断带 `[ref:tool_call_id#row_id]`，前端可点击展开原始数据行。
7. **P2 · LLM-as-judge**：对 faithfulness（是否忠于数据）和 relevancy（是否答所问）做自动打分，纳入 CI。

---

## 优先级路线图

### 第一梯队 · 立刻做（安全 + 正确性，累计约 1 周）

| 项 | 维度 | 工作量 |
|---|---|---|
| 抢救 `agent/` 源码，纳入版本控制 | 全局 | 0.5–2 天 |
| SQLite 开 WAL + busy_timeout | 5 | **10 分钟** |
| actorScope 绑定认证身份 + CORS 收紧 + 限流 | 4 | 1–2 天 |
| embedding 缓存键加入模型版本 | 1 | **10 分钟** |
| 所有出站调用套 deadline | 6 | 半天 |
| uvicorn `--workers 4` | 5 | **5 分钟** |

> 注意前四项里有三项是**分钟级改动**，但影响面极大。先做这些。

### 第二梯队 · 一个月内（可度量 + 可运维）

- 结果集级 golden set + GitHub Actions CI 闸门（维度 7）
- 意图路由改双层（正则 + LLM 兜底），confidence 真实化（维度 3）
- `MemorySaver` → `SqliteSaver`，会话持久化（维度 5）
- 统一 `withRetry` + 熔断器（维度 6）
- 数值锚定校验（维度 7）
- 工具并行执行（维度 3）

### 第三梯队 · 一个季度（企业级能力）

- 冲突消解声明模型 + schema drift 检测（维度 2）
- 实体解析骨架，为接入第二数据源铺路（维度 2）
- ANN 向量索引（hnswlib）（维度 1）
- 审计日志哈希链 + PII 自动扫描（维度 4）
- 主链路反馈闭环 + LLM-as-judge（维度 7）
- 长任务队列化 + Node cluster（维度 5）

---

## 最后说三句实话

**第一，你的本体层是真资产。** 28 实体 / 50 维度 / 30 指标 + 指纹校验 + actorScope + 敏感字段脱敏这套东西，很多号称企业级的产品也只做到声明层。"结构化契约替代裸 SQL"的选择更是和 Cortex Analyst 走在同一条正确的路上。别因为下面这些差距就怀疑整体架构——**架构方向是对的，问题都在工程化落地上。**

**第二，最危险的不是差距，是不可见。** 网关无认证让本体层的权限体系形同虚设；没有执行级评测让你不知道系统准确率究竟是多少；`agent/` 只剩字节码让核心逻辑无法审计。这三件事的共同点是：**它们让你对自己的系统失去了确定性。** 企业级和原型的真正分界线不是功能多少，而是"你能不能证明它是对的"。

**第三，别被清单吓到。** 上面第一梯队里有三项是十分钟内能改完的（WAL、embedding 缓存键、uvicorn workers），却能立刻带来数量级的改善。先把这些摘了，再去啃认证和评测。

