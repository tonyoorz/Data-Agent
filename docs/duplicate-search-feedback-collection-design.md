# Duplicate Search Agent — 反馈采集与训练数据生成设计

> 目标：让 agent 在自然使用中**有效收集反馈**，并把**整个交互过程**捕获成可蒸馏的训练数据。核心改造点：把每次搜索从"孤立的 (query, ticket, signal)"升级为"带完整上下文的 Search Session"。

---

## 一、现状缺口

当前反馈链路（`DuplicateSearchResults.tsx` → `/api/duplicate-feedback` → `feedback_store.submit_feedback`）：

- 前端只有 👍/👎 + 点 ticket 跳转 Octane 记 click。
- 提交时只传 `queryText / ticketId / signal / baseScore / rankPos`。
- `feedback_records` 表只存 signal + base_score + rank_pos + user_id。

**三大缺口：**
1. **没有 session 概念**——每次反馈是孤立的，不知道当时候选列表、排序、分数。
2. **推理上下文全丢**——hints、候选快照、model_phase 都没存，无法蒸馏推理过程。
3. **只有显式反馈**——click/dwell/abandon/query 改写这些高频隐式信号没采集，导致反馈量上不去（当前仅 8 条）。

---

## 二、设计理念：Search Session 作为统一载体

**一次搜索 = 一个 session = 一个训练样本。**

不是孤立收集 `(query, ticket, signal)`，而是把每次搜索 + 后续所有交互打包成一个 session。session 记录完整的推理上下文快照，所有反馈和行为作为事件挂在 `session_id` 上。

这样做的关键意义：
- 反馈不再脱离上下文——知道当时检索到什么、怎么排的、为什么用户点了这个。
- 哪怕用户只点了一下 click、甚至 abandon（看完没点），session 也能转成训练数据。
- 推理过程被完整捕获，可供 teacher 蒸馏 reasoning chain。

---

## 三、三层反馈采集

### Layer 1：隐式信号（零摩擦，量大，被动收集）

用户无感，纯行为捕获。这是突破冷启动的主力——每次搜索都产数据。

| 信号 | 触发 | 含义 | 权重 |
|------|------|------|------|
| `click` | 点 ticket id 跳 Octane | 弱正 | 0.3 |
| `dwell` | 候选卡片展开/停留 >3s | 关注 | 0.2 |
| `copy` | 复制 ticket id | 强关注 | 0.4 |
| `abandon` | 看完结果无任何交互离开 | 弱负 | -0.1 |
| `rewrite` | 改写 query 重搜 | 当前结果不满意 + query 演化 | 特殊 |

### Layer 2：显式反馈（低摩擦，高质量，主动但轻量）

不打扰、不弹窗，嵌入候选卡片的自然操作流。

| 信号 | 触发 | 含义 | 权重 |
|------|------|------|------|
| `positive` | 👍（已有） | 命中 | 1.0 |
| `negative` | 👎（已有） | 不相关 | -1.0 |
| `confirm` | "这就是重复"确认按钮 | 强正，明确认定 | 1.5 |
| `reject_all` | "都不对，换个找法"按钮 | 整次搜索强负 | -0.8 |

### Layer 3：延迟强信号（最高质量，异步回传）

Ground truth，通过定时任务回扫 Octane 拿到：

| 信号 | 来源 | 含义 | 权重 |
|------|------|------|------|
| `linked` | agent comment 回写后用户/系统确认 link | 确认重复 | 2.0 |
| `status_duplicate` | 工单状态变为 duplicate-closed | 确认重复 | 2.0 |

---

## 四、Search Session 数据模型

### 4.1 新增表（在 `feedback_store.py` 扩展）

```sql
-- 搜索会话：一次搜索的完整上下文快照
CREATE TABLE IF NOT EXISTS search_sessions (
    session_id      TEXT PRIMARY KEY,          -- UUID
    search_id       TEXT,                       -- 现有 searchId
    query_text      TEXT NOT NULL,
    query_hash      TEXT NOT NULL,
    hints           TEXT,                       -- JSON: {project,pu,ecu,lead_model}
    candidates_snapshot TEXT NOT NULL,          -- JSON: 完整候选列表+排序+分数+ranking_signals
    model_phase     TEXT,
    dataset_size    INTEGER,
    user_id         TEXT,
    created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ss_query ON search_sessions(query_hash);
CREATE INDEX IF NOT EXISTS idx_ss_user_time ON search_sessions(user_id, created_at);

-- 反馈事件：所有行为挂在 session 上（替代/扩展 feedback_records）
CREATE TABLE IF NOT EXISTS feedback_events (
    event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    ticket_id       TEXT,
    event_type      TEXT NOT NULL,              -- click/dwell/copy/abandon/positive/negative/confirm/reject_all/rewrite/linked/status_duplicate
    rank_pos        INTEGER,
    base_score      REAL,
    dwell_ms        INTEGER,                    -- dwell 类型用
    user_reason     TEXT,                       -- 可选用户理由
    created_at      REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES search_sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_fe_session ON feedback_events(session_id);
CREATE INDEX IF NOT EXISTS idx_fe_ticket ON feedback_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_fe_type ON feedback_events(event_type);

-- query 演化链：同一搜索意图的多次重搜
CREATE TABLE IF NOT EXISTS query_rewrites (
    rewrite_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id        TEXT NOT NULL,              -- 同一搜索意图的多次重搜共享
    from_query      TEXT NOT NULL,
    to_query        TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_chain ON query_rewrites(chain_id);
```

### 4.2 关键设计点

- `candidates_snapshot` 存完整候选快照（JSON），即使后续 ticket 数据变化，session 仍能复现当时的检索结果。
- `feedback_events` 用统一事件模型，click/dwell/positive 都是 event，只是 `event_type` 不同——简化采集和转换。
- `query_rewrites` 单独建表，因为它是 query 维度的演化数据，不属于单次 session。

---

## 五、交互流设计（前端改造）

### 5.1 搜索结果展示时

```
用户发起搜索
  → 后端 search action 返回 session_id（新增）
  → 前端拿到 candidates + session_id
  → 前端自动建 session 快照（或后端 search 时已落库 search_sessions）
```

### 5.2 候选卡片交互埋点

| 行为 | 现状 | 改造 |
|------|------|------|
| 点 ticket id | 已记 click | 保留，附带 session_id |
| 展开 evidence | 无 | 新增 dwell 埋点（展开 + 停留计时） |
| 复制 ticket id | 无 | 新增 copy 埋点（监听 copy 事件） |
| 👍/👎 | 已有 | 保留，附带 session_id |
| 结果离开 | 无 | 新增 abandon 埋点（组件卸载时若无任何交互） |

### 5.3 新增两个低摩擦按钮（结果底部）

- **"找到重复了"** → `confirm` 信号，并让用户点选哪个候选（强正）。
- **"都不对，换个找法"** → `reject_all` 信号，触发 query 改写引导（"试试加上 PU/日志关键词"）。

### 5.4 query 改写关联

用户改 query 重搜时，前端把新旧 query 关联到同一 `chain_id`（基于会话上下文或用户意图判定），写入 `query_rewrites`。

---

## 六、Session → 训练数据转换管道

新建 `backend/distillation/session_to_training.py`，把 session 转成 4 类训练数据。

### 6.1 偏好对（DPO / rank loss）

```python
# 同一 session 内，按信号权重构造偏好对
def session_to_preference_pairs(session):
    events = session.events
    positives = [e for e in events if e.weight > 0]   # confirm/positive/click/copy
    negatives = [e for e in events if e.weight < 0]   # negative/reject_all
    pairs = []
    for pos in positives:
        for neg in negatives:
            pairs.append({
                "query": session.query_text,
                "chosen": pos.ticket_id,
                "rejected": neg.ticket_id,
            })
    # 强偏好：排在前但 negative vs 排在后但 click（纠正排序错误）
    for neg in negatives:
        for pos in positives:
            if neg.rank_pos < pos.rank_pos:
                pairs.append({...strong_pair...})
    return pairs
```

### 6.2 Listwise ranking grades

```python
# 一个 session 的所有候选打 relevance grade
GRADE_MAP = {
    "linked": 3, "status_duplicate": 3, "confirm": 3,
    "positive": 2, "click": 2, "copy": 2,
    "dwell": 1,
    "negative": 0, "reject_all": 0,
    # 未交互候选: 0.5（未知）
}
def session_to_listwise(session):
    grades = {}
    for e in session.events:
        tid = e.ticket_id
        grades[tid] = max(grades.get(tid, 0.5), GRADE_MAP[e.event_type])
    # 候选快照里未出现在 events 的 → 0.5
    for cand in session.candidates_snapshot:
        grades.setdefault(cand.ticket_id, 0.5)
    return {
        "query": session.query_text,
        "candidates": [c.ticket_id for c in session.candidates_snapshot],
        "grades": [grades[c.ticket_id] for c in session.candidates_snapshot],
    }
```

### 6.3 query 演化训练数据

```python
# query_rewrites → query 改写/扩展训练对
def rewrites_to_training():
    rows = load_query_rewrites()
    return [{"source": r.from_query, "target": r.to_query} for r in rows]
    # 喂 query 扩展模型：学"用户怎么把模糊 query 改成有效 query"
```

### 6.4 真实 hard negative

```python
# 排名 top-3 但 negative = 真实难负样本
def sessions_to_hard_negatives():
    hard_negs = []
    for session in all_sessions:
        for e in session.events:
            if e.event_type == "negative" and e.rank_pos <= 3:
                hard_negs.append({
                    "query": session.query_text,
                    "hard_negative_ticket": e.ticket_id,
                    "rank_pos": e.rank_pos,
                })
    return hard_negs
```

---

## 七、工程改造点

| 文件 | 改造 | 优先级 |
|------|------|--------|
| `backend/feedback_store.py` | 新增 `search_sessions` / `feedback_events` / `query_rewrites` 表 + 读写方法 | P0 |
| `scripts/duplicate_search_bridge.py` | search action 生成 `session_id` 并落库 session 快照；feedback action 接收 `session_id` + `event_type` | P0 |
| `server/index.mjs` | `/api/duplicate-feedback` 透传 session_id + event_type；新增 `/api/duplicate-session-event` 批量上报隐式事件 | P0 |
| `src/components/dashboard/chat/DuplicateSearchResults.tsx` | 埋点 dwell/copy/abandon；加"找到重复"/"都不对"按钮；query 改写关联 chain_id | P0 |
| 新建 `backend/distillation/session_to_training.py` | 4 种转换管道 | P1 |
| `backend/analytics/duplicate_comment_runner.py` | link 确认后回写 `feedback_events(linked)` | P1 |
| 新建 `backend/distillation/octane_status_scanner.py` | 定时回扫工单状态变 duplicate 的 → `status_duplicate` 事件 | P2 |

---

## 八、为什么这样能突破冷启动

1. **隐式信号量大**——每次搜索都产 click/dwell/abandon 数据，不依赖用户主动点 👍。8 条显式反馈的局面会被打破。
2. **session 上下文完整**——哪怕只有 click，也能转成偏好对（click 的 > 未点的），弱信号也能用。
3. **query 改写是免费数据**——用户自然就会改 query，`(q1→q2)` 直接喂 query 扩展模型，零额外摩擦。
4. **延迟强信号提供 ground truth**——link 确认和工单状态是真实标签，校准弱信号。
5. **一次搜索 = 一个训练样本**——数据生产效率从"每次反馈 1 条"提升到"每次搜索 N 条事件"。

---

## 九、落地顺序

1. **P0（1 周）**：session 数据模型 + 桥接 + 前端埋点。先让数据采起来，哪怕还没训练。
2. **P0（3 天）**：转换管道 `session_to_training.py`，验证能产出偏好对/grades。
3. **P1（1 周）**：link 确认回写 + query 改写关联。
4. **积累期（2-4 周）**：让 session 数据自然积累，目标 ≥500 session。
5. **接入训练**：session 数据 warm-start + 反馈蒸馏推理主路径（见 `duplicate-search-distillation-improvement-plan.md`）。

---

## 十、一句话总结

**把每次搜索变成一个带完整上下文的 session，三层反馈（隐式/显式/延迟）挂在 session 上，session 本身就是训练样本。** 这样反馈采集从"等用户点 👍"变成"每次搜索都在产数据"，推理上下文完整保留可供蒸馏，冷启动和训练数据稀缺问题一并解决。

---

## 十一、隐私、保留与审计边界

Search session 和 feedback event 都可能包含 query、ticket 标题、候选 snippet、user ID 或人工理由。这些属于训练/分析原始数据，不应混入 Agent Operations runtime summary。

- 训练反馈库按最小权限访问，导出训练集前去除 user ID、cookie、token、完整 Octane URL 和不必要的个人字段。
- runtime audit 与 feedback session 分开保留；runtime summary 只保留 opaque run reference、意图、脱敏状态、恢复/citation 聚合和允许的工具名。
- 推荐把原始 feedback/session 数据保留期、导出审批人和删除流程写入部署侧数据治理策略；仓库不自动删除生产反馈数据。
- 反馈 API 不能接受或持久化 OIDC bearer、actor capability、模型 access code、cookie 或浏览器 session token。
- 用于模型训练/蒸馏的导出必须在非生产副本完成，并保留导出版本、样本筛选规则和审批记录。
