# Duplicate Search Agent — 反馈蒸馏与小模型能力提升方案

> 基于 `backend/duplicate_issue_finder.py` / `progressive_reranker.py` / `feedback_store.py` / `duplicate_search_eval.py` 现状，结合业内检索 + 数据蒸馏工程实践给出改进路线。

---

## 一、现状诊断（有数据支撑）

### 1.1 数据资产盘点

| 资产 | 数量 | 位置 | 评价 |
|------|------|------|------|
| ticket embeddings | 9,230 | `backend/database/ticket_embeddings.db` | 充足，且已 L2 归一化缓存 |
| feedback_records | **8** | `backend/database/duplicate_feedback.db` | 严重不足 |
| reranker_models | 0 | 同上 | 从未训练过 |
| adapter_weights | 0 | 同上 | 从未训练过 |
| agent comment runs | 1 | `database/hot/duplicate_agent_comment_runs.db` | 回写几乎没跑 |
| octane_defects | 9,230+ | `vizion_serving.db` | 有丰富文本，无 linked/related 字段 |

### 1.2 检索内核评价：合理，保留

`duplicate_issue_finder.py` 的检索架构已经是业内标准做法，不需要大改：

- **Hybrid retrieval**：BGE-small-zh（dense）+ TF-IDF char n-gram（sparse），用 RRF 融合 ✓
- **自适应权重**：`_retrieval_weights_for_query` 对标识符类 query（DTC / trace / 日志）倾向 sparse，符合 BM25 对精确 token 更强的事实 ✓
- **Embedding SQLite 缓存 + 增量更新**：`_EmbeddingCache` 按 text_hash 失效，避免重复编码 ✓
- **Hint 抽取 + boost**：project / PU / ECU / lead_model 的结构化过滤 ✓
- **置信度校准层**：`calibrate_duplicate_confidence` 不做线性映射，叠加 rank bonus ✓

**结论：检索底座是 SOTA 标配，保留作为召回层。问题不在召回，在召回之后的"学习"和"数据生产"。**

### 1.3 三大瓶颈根因

#### 瓶颈 1：冷启动困境，学习层空转

`TrainingScheduler` 阈值：feature 需 50 条、adapter 需 200 条，retrain 间隔 20。当前只有 8 条反馈，`current_phase()` 永远返回 `click_boost`，`FeatureReRanker` 和 `ContrastiveAdapter` **从未被触发**。progressive 设计本身正确，但没有"冷启动数据注入"机制，导致整个学习层是摆设。

#### 瓶颈 2：reranker 能力上限低

- `FeatureReRanker` 用 LogisticRegression + 9 维手工特征（similarity / hint 匹配 / token overlap / rank_pos / popularity / query 长度）。特征工程合理但容量受限，无法捕捉语义级重复判断。
- `ContrastiveAdapter` 只是**对角权重矩阵**（`np.diag(diagonal)`），不是真正的 metric learning。它只能逐维缩放 embedding，无法学习维度间的交互，能力远弱于一个 LoRA 微调或全秩 projection head。
- `_pseudo_ndcg` 在**训练集**上计算，无 holdout，无法检测过拟合，`ModelSafetyGuard` 的回归门禁实际是"在训练集上不退步"，意义有限。

#### 瓶颈 3：完全没有数据生产管线

全仓搜索 `distill / teacher / synthetic / hard negative mining` 零命中（业务代码）。9,230 条未标注 ticket 闲置，没有 teacher LLM 蒸馏、没有合成 query、没有 hard negative mining。同时 `octane_defects` 表**没有 linked / duplicate_of 字段**，无法免费获得真实重复对，必须靠蒸馏生产监督信号。

---

## 二、改进方案（分阶段，结合 SOTA）

### 数据策略修正：主路径是反馈蒸馏推理，静态打标签仅作桥接

> 架构修正（2026-07-10）：初版方案过度偏重"静态数据 + LLM 打标签"，对"靠用户反馈蒸馏推理过程"这条主路径强调不够。经讨论修正优先级如下。

训练数据有两条来源，**主次必须分清**：

**主路径 — 用户反馈蒸馏推理过程（长期主力，质量最高）**

不是只蒸馏 duplicate/not-duplicate 标签，而是蒸馏**推理链**。具体机制：

1. **反馈时记录推理上下文**（当前 `feedback_store` 只存 signal，是最大缺口）。升级 `feedback_records` 表，反馈时同时落库：当时的候选列表 + 排序分数 + hint 抽取结果 + 用户理由（可选自由文本）。没有这一步，推理过程根本没被捕获，无从蒸馏。
2. **构造偏好对**：同一 query 下，用户点 positive 的 ticket 排在 negative 之前，形成 `(query, chosen, rejected)` 偏好对——这是 DPO / rank loss 的标准输入。比 LLM 伪标签可信，因为是用户真实偏好。
3. **teacher 输出 reasoning chain**：对偏好对，teacher 不仅判 duplicate，还输出"为什么"的推理链。把推理过程也作为训练目标（rationale distillation），小模型学到的是"怎么推理出对的"而非"什么是对的"。
4. **反馈驱动 hard negative**：用户点 negative 但检索排名很高的 ticket = 真实难例，比静态 LLM 判定的 hard negative 更可信。

**桥接路径 — 静态数据 + LLM 打标签（仅冷启动，量大但伪标签）**

9,230 条静态 ticket 靠 coarse search 召回候选对 + LLM pairwise 判定产生伪标签，做 warm-start。**它的定位是桥接**：当前只有 8 条反馈，纯靠反馈会卡死冷启动；静态蒸馏让模型先跑起来、先能服务，从而吸引更多真实反馈。反馈积累到一定量（如 ≥500 条偏好对）后，主路径接管，静态蒸馏退为长尾补充。

**两条路径的时序关系**：桥接启动（静态 warm-start）→ 反馈积累 → 切换主路径（反馈蒸馏推理）→ 主路径持续优化 + 静态补长尾。不是二选一，是流水线两段，但主路径是目标态。

### Phase 0 — 评估基线先行（1 周）

**目标：建立可对比的 golden set，没有 baseline 一切改进都无法验证。**

1. **LLM-as-judge 构建 golden set**
   - 从 9,230 ticket 中分层采样 200 个 anchor（按 project × PU 分层）。
   - 对每个 anchor 跑现有 coarse search 取 top-20。
   - 用 teacher LLM 对每个 (anchor, candidate) 判定是否重复（label + 0-3 relevance grade）。
   - 人工抽检 10%（约 400 pair）校准 LLM 标注质量，剔除系统性偏差。

2. **跑 baseline 指标**
   - 复用 `duplicate_search_eval.py` 的 `evaluate_duplicate_search`，计算 Recall@10 / MRR@10 / nDCG@10 / Precision@10。
   - 这就是后续所有改进的回归基线。

**产出**：`docs/duplicate-search-golden-set.json` + baseline 指标报告。

---

### Phase 1 — LLM 蒸馏数据生产流水线（2-3 周，解决冷启动）

**这是整个改进的核心。** 目标：用 teacher LLM 把 9,230 条闲置 ticket 转成训练数据，warm-start progressive reranker，突破 8 条反馈的冷启动。

#### 数据前提：静态 + 无标签怎么处理

这 9,230 条 ticket 是静态的（不随反馈实时增长）、且没有任何分类标签（既无"是否重复"关系标签，也无故障类别体系），`octane_defects` 表也没有 linked/duplicate_of 字段。这恰恰是蒸馏要解决的输入状态，处理原则如下：

**1. duplicate 判定是 pairwise 问题，不是单票分类问题。** 不需要预先建一套故障类别体系把每张票分到桶里——那是多分类任务，标签从哪来反而更难。duplicate search 的本质是判定"任意两张票是不是同一回事"，直接在 pair 级别做语义判定即可。ticket 自带的 project / PU / ECU 字段只作为**先验**缩小搜索空间，不是分类标签。

**2. 无标签靠 LLM 弱监督伪标签。** teacher LLM 就是来给 unlabeled pair 打标签的：判 (A,B) 是否重复 + 置信度 + reasoning。这是弱监督 / pseudo-labeling 的标准范式（Snorkel、LLM-as-judge），检索领域的 cross-encoder 蒸馏（MS-MARCO、BEIR）训练数据本身也是这么产的。

**3. 静态是优势，不是缺陷。** 静态数据适合离线批量蒸馏——一次标注永久复用，不存在在线标注的延迟和一致性问题。真正的动态增量靠两条：① 新 ticket 进来时只对增量做蒸馏（复用已缓存 embedding，只处理新增 anchor）；② 真实用户反馈持续回流，逐步覆盖 / 修正伪标签。

**4. 必须缩小配对空间。** 9230 条全量两两配对是 9230² ≈ 8500 万对，不可行。用 embedding 聚类（同 project/PU + 语义近邻）建簇，只在簇内 + 现有 coarse search top-50 内配对，降到约 1000 anchor × 50 = 5 万对，成本可承受。

**5. LLM 会错，用三重质控兜底。** 伪标签噪声是弱监督的核心风险，靠三重控制：① 双向一致性（(A,B) 和 (B,A) 各判一次，不一致的剔除）；② 置信度门槛（≥0.8 才进训练集）；③ 主动学习（uncertain 的优先送人工标注，提升边际数据质量）。

#### Step 1：Anchor 采样 + 候选召回

```
9230 ticket
  → 按 (project, pu) 聚类，每簇采样 N 个 anchor（保证覆盖度）
  → 对每个 anchor 复用现有 _coarse_search 取 top-50 候选
  → 产出 (anchor, candidate) pair 池
```

复用 `DuplicateIssueIndex._coarse_search`，不引入新检索逻辑。9230 anchor × 50 = ~46 万 pair，可按成本裁剪到 anchor 采样 1000-2000 个。

#### Step 2：Teacher LLM judge

对每个 (anchor, candidate) pair，teacher LLM 输入两段 defect 文本（name + description + search_comments + evidence），输出：

```json
{
  "is_duplicate": true | false | uncertain,
  "confidence": 0.0-1.0,
  "relevance_grade": 0-3,      // 0=无关 1=相关 2=可能重复 3=确认重复
  "reasoning": "..."           // 判断依据，用于后续 rationale 蒸馏
}
```

**关键工程点：**
- **成本控制**：anchor-candidate pair 文本超长时先做 `_build_document` 截断；用 batch 推理；uncertain 的不进训练集。
- **一致性校验**：对 (A,B) 和 (B,A) 各判一次，不一致的剔除或降权——这是过滤 LLM 噪声标注的有效手段。
- **置信度门槛**：只保留 confidence ≥ 0.8 的作为强标签，其余作为弱标签。

**产出**：`distillation_pairs.jsonl`，每行一条 (anchor_id, candidate_id, label, grade, confidence)。

#### Step 3：Hard negative mining

这是当前 `ContrastiveAdapter` 最缺的东西。当前 `_build_adapter_triplets` 把所有负反馈当 negative，没有难例区分。

**Hard negative 定义**：coarse search 召回排名靠前（top-10）但 teacher judge=否 的 candidate——它们与 anchor 高度相似却不是重复，是最有学习价值的边界样本。

```
对每个 anchor:
  positives   = judge=yes 的 candidate
  hard_negs   = top-10 中 judge=no 的 candidate   ← 重点
  easy_negs   = rank 30-50 中 judge=no 的 candidate（随机采样少量）
```

同时挖掘**同 project / 同 PU 的近邻干扰项**——这类 ticket 字段相近但根因不同，是 duplicate 判断最容易错的。

#### Step 4：训练数据集产出

一份蒸馏产出三类数据集，喂给不同模型路径：

| 数据集 | 格式 | 用途 |
|--------|------|------|
| pair classification | (text_a, text_b, label) | Cross-encoder 微调 |
| triplets | (query, positive, hard_negative) | Embedding 对比学习 |
| ranking | (query, [candidates], grades) | Listwise reranker / LambdaMART |

**合成 query 增强**：从 anchor ticket 的 name + description 生成自然语言 query（模拟用户输入"现象 + 项目 + PU + 日志"），并对同一 anchor 生成 3-5 种不同表述改写，扩充 (query, ticket) 对的多样性。这直接补充 `feedback_records` 里 query 维度信号的缺失。

**产出**：`backend/distillation/` 目录下三个数据集 + 生成脚本。

---

### Phase 2 — 模型升级（3-4 周，三路径并行）

#### 路径 A：Cross-encoder reranker（短期，高收益，优先做）

**替代当前 `FeatureReRanker`（LR + 手工特征），能力提升一个量级。**

- 基座：`BAAI/bge-reranker-base` 或 `BAAI/bge-reranker-v2-m3`（中英双语，轻量）。
- 输入：`[CLS] query [SEP] candidate_text [SEP]`，输出相关性分。
- 微调数据：Phase 1 的 pair classification + ranking 数据。
- 集成：在 `ProgressiveReRanker.rerank` 里，当 cross-encoder 就绪时替代 feature_reranker 分支。
- 推理成本：top-50 候选过 cross-encoder，单次 ~50ms（CPU），可接受。

**为什么不是直接换大模型**：cross-encoder 只对召回后的 50 个候选精排，不在召回层，延迟可控；且 bge-reranker-base 只有 ~110M 参数，本地可跑。

#### 路径 B：Embedding LoRA 微调（中期，治本）

**替代当前 `ContrastiveAdapter`（对角缩放），用真正的对比学习优化 embedding 空间。**

- 基座：保留 `BAAI/bge-small-zh-v1.5`，加 LoRA adapter（rank=8-16）。
- Loss：InfoNCE，in-batch negatives + 显式 hard negative。
- 数据：Phase 1 的 triplets。
- 优势：embedding 空间本身变好，dense 召回质量直接提升，不只是 rerank。
- 部署：LoRA adapter 体积小（~10MB），可热加载；原 BGE 权重不变，安全回退。

**与路径 A 的关系**：A 治标（rerank 精排），B 治本（召回 embedding）。两者可叠加：LoRA 微调后的 embedding 进 dense 召回，cross-encoder 做 final rerank。

#### 路径 C：端到端小模型 + rationale 蒸馏（长期，可选）

- 把 teacher 的 `reasoning` 也蒸馏进小模型，让它学会"为什么重复"而非只输出分数。
- 如果 cross-encoder 仍嫌重，蒸馏成更小的专用 duplicate classifier（如 3 层 transformer）。
- 适合模型体积 / 延迟有严格约束的部署场景。

---

### Phase 3 — 评估闭环与持续学习（持续）

#### 3.1 Holdout 评估（修当前过拟合问题）

当前 `_pseudo_ndcg` 在训练集计算，改为：

```
蒸馏数据 → 80/20 split → train / holdout
训练后在 holdout 上算 nDCG@10 / Recall@10
ModelSafetyGuard 门禁：holdout nDCG 回退 > 3% 则不部署
```

#### 3.2 降阈值 + warm-start

- `FEATURE_THRESHOLD` 50 → 30，`ADAPTER_THRESHOLD` 200 → 120（蒸馏数据补足后可调回）。
- 用 Phase 1 蒸馏数据做 **warm-start 预训练**：feature / adapter 阶段一上来就有几千条数据，不再卡冷启动。

#### 3.3 双信号回流

- **显式反馈**：用户 click / positive / negative（现有机制，保留）。
- **隐式反馈**：agent comment 回写（`duplicate_comment_runner`）执行后，被 linked 的 ticket 自动作为正样本。当前只跑了 1 次，应接入日常批量任务。

#### 3.4 Drift 检测 + 自动重训

- 监控线上 nDCG / Recall 周环比，下降 > 5% 触发重蒸馏 + 重训。
- teacher LLM 升级后（如换更强模型）重跑 Step 2，刷新标签。

---

## 三、现有代码具体改造点

| 文件 | 改造点 | 优先级 |
|------|--------|--------|
| `backend/progressive_reranker.py` `FeatureReRanker` | 新增 `CrossEncoderReRanker` 类（路径 A），`rerank()` 优先调用 | P0 |
| `backend/progressive_reranker.py` `ContrastiveAdapter` | 替换为 LoRA 微调 hook（路径 B），保留接口兼容 | P1 |
| `backend/progressive_reranker.py` `_pseudo_ndcg` | 改为 holdout 评估，加 train/val split | P0 |
| `backend/feedback_store.py` `TrainingScheduler` | 阈值下调 + 增加 `warm_start(蒸馏数据)` 入口 | P0 |
| `backend/feedback_store.py` | 新增 `distillation_pairs` 表存储 teacher 标签 | P1 |
| 新建 `backend/distillation/` | teacher judge 脚本 + hard neg mining + 数据集生成 | P0 |
| 新建 `backend/distillation/cross_encoder_train.py` | bge-reranker 微调 + 导出 | P0 |
| `backend/duplicate_search_eval.py` | 接入 golden set 持续评测，输出回归报告 | P0 |
| `backend/analytics/duplicate_comment_runner.py` | 接入日常批量任务，linked ticket 回流为正样本 | P1 |
| `scripts/duplicate_search_bridge.py` | 暴露 `/api/duplicate-eval` 端点跑 golden set | P1 |

---

## 四、落地路线图

```
Phase 0 (1周)   评估基线
  └─ golden set 200 anchor × 20 = 4000 pair, baseline 指标

Phase 1 (2-3周) 蒸馏数据生产  ← 核心瓶颈突破
  └─ anchor 采样 1000-2000, teacher judge, hard neg, 三类数据集
  └─ warm-start 注入, feature 阶段首次有数据

Phase 2-A (2周) Cross-encoder  ← 短期最大收益
  └─ bge-reranker 微调, 替代 LR, holdout nDCG 验证

Phase 2-B (3周) Embedding LoRA ← 中期治本
  └─ InfoNCE + hard neg, dense 召回质量提升

Phase 3 (持续)  闭环
  └─ drift 检测, 自动重训, 隐式反馈回流
```

**优先级建议**：Phase 0 → Phase 1 → Phase 2-A 串行做（A 依赖 1 的数据），Phase 2-B 可与 2-A 并行，Phase 3 在 2-A 上线后启动。

---

## 五、评估指标设计

| 指标 | 当前 | 改进后目标 | 验证方式 |
|------|------|-----------|----------|
| holdout nDCG@10 | 无（训练集计算） | ≥ baseline + 5% | golden set 回归 |
| Recall@10 | 无 | ≥ 0.75 | golden set |
| MRR@10 | 无 | ≥ 0.65 | golden set |
| rerank 延迟 | ~10ms (LR) | < 80ms (cross-encoder, top-50) | 线上 P95 |
| feature 阶段激活 | 从未 | 蒸馏后立即 | feedback_count + warm-start |
| 模型回退率 | 无 | < 5% | ModelSafetyGuard 日志 |

---

## 六、风险与缓解

| 风险 | 缓解 |
|------|------|
| teacher LLM 标注噪声 | 双向判定一致性校验 + 人工抽检 10% + 置信度门槛 |
| 蒸馏成本（token） | anchor 采样控制在 1000-2000，batch 推理，文本截断 |
| cross-encoder 延迟 | 只对 top-50 精排，非全量；CPU 量化（ONNX / int8） |
| LoRA 微调过拟合 | 早停 + holdout 监控 + adapter 可热卸载回退 |
| 蒸馏标签与真实用户偏好偏差 | 蒸馏数据只做 warm-start，真实反馈持续回流覆盖 |

---

## 七、一句话总结

**检索底座不动，补齐"LLM 蒸馏产数据 → warm-start 突破冷启动 → cross-encoder 升级 rerank → holdout 评估闭环"这条链。** 当前 8 条反馈让 progressive reranker 空转，9230 条闲置 ticket 是被浪费的金矿——用 teacher LLM 把它们变成训练数据，是性价比最高的一步。
