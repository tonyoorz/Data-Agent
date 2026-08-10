/**
 * Metric Glossary — 语义指标层增强
 *
 * 从 Ontology Registry 的 metrics/dimensions/entities 自动生成:
 * 1. LLM 可用的指标词典上下文 (Metric Glossary Prompt)
 * 2. 自然语言→指标的模糊路由 (Metric Router)
 * 3. 指标关系图谱 (Metric Relationship Map)
 * 4. 指标推荐引擎 (Metric Recommender)
 *
 * 学习对象: Snowflake Cortex Semantic Layer + dbt Metrics
 */

// ─── Types ───

/**
 * @typedef {Object} MetricInfo
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {string} unit
 * @property {string[]} allowedDimensions
 * @property {string} governanceStatus
 * @property {string[]} aliases
 * @property {string|null} numerator
 * @property {string|null} denominator
 * @property {string|null} measure
 * @property {Object|null} capabilities
 */

/**
 * @typedef {Object} MetricRelationship
 * @property {string} type — "ratio" | "composition" | "filter_refinement" | "time_variant"
 * @property {string} fromMetric
 * @property {string} toMetric
 * @property {string} formula
 * @property {string} description
 */

// ─── 1. Metric Glossary Generator ───

/**
 * 从 registry 生成结构化的指标词典，注入 LLM system prompt。
 *
 * @param {Object} registry — Ontology Registry
 * @param {Object} [options]
 * @param {string} [options.locale="zh-CN"] — 语言
 * @param {boolean} [options.includeDrafts=true] — 是否包含 draft 状态指标
 * @param {string[]} [options.focusMetricIds] — 聚焦的指标 ID 列表（上下文裁剪）
 * @returns {string} 结构化的指标词典文本
 */
export function buildMetricGlossary(registry, options = {}) {
  const { locale = "zh-CN", includeDrafts = true, focusMetricIds = null } = options;
  const metrics = registry.listMetrics()
    .filter((m) => includeDrafts || m.governance.status === "approved")
    .filter((m) => !focusMetricIds || focusMetricIds.includes(m.id));

  const dimensions = registry.bundle.dimensions || [];
  const dimMap = new Map(dimensions.map((d) => [d.id, d]));

  const lines = [];
  lines.push("# 指标词典 (Metric Glossary)");
  lines.push(`Ontology Version: ${registry.version}`);
  lines.push(`Total Metrics: ${metrics.length}`);
  lines.push("");

  // Group by entity
  const byEntity = new Map();
  for (const metric of metrics) {
    const entityId = metric.entityId || "unknown";
    if (!byEntity.has(entityId)) byEntity.set(entityId, []);
    byEntity.get(entityId).push(metric);
  }

  for (const [entityId, entityMetrics] of byEntity) {
    const entity = registry.getEntity(entityId);
    const entityLabel = entity?.labels?.[locale] || entityId;
    lines.push(`## ${entityLabel} (${entityId})`);
    lines.push("");

    for (const metric of entityMetrics) {
      const label = metric.labels?.[locale] || metric.id;
      const status = metric.governance?.status === "approved" ? "✅" : "⚠️";
      lines.push(`### ${status} ${label} — \`${metric.id}\``);
      lines.push(`- **定义**: ${metric.description || "N/A"}`);

      if (metric.measure) {
        lines.push(`- **计算**: \`${metric.measure}\``);
      }
      if (metric.numerator && metric.denominator) {
        lines.push(`- **分子**: \`${metric.numerator}\``);
        lines.push(`- **分母**: \`${metric.denominator}\``);
      }

      lines.push(`- **单位**: ${metric.unit || "count"}`);

      // Allowed dimensions with labels
      const allowedDims = (metric.allowedDimensions || [])
        .map((dimId) => {
          const dim = dimMap.get(dimId);
          return dim ? `${dim.labels?.[locale] || dimId}(\`${dimId}\`)` : dimId;
        });
      if (allowedDims.length) {
        lines.push(`- **可用维度**: ${allowedDims.join(", ")}`);
      }

      // Required filters
      if (metric.requiredFilters?.length) {
        lines.push(`- **必须筛选**: ${metric.requiredFilters.join(", ")}`);
      }

      // Capabilities
      if (metric.capabilities) {
        const caps = Object.entries(metric.capabilities)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ");
        if (caps) lines.push(`- **能力**: ${caps}`);
      }

      // Missing data policy
      if (metric.missingDataPolicy) {
        lines.push(`- **缺失数据处理**: \`${metric.missingDataPolicy}\``);
      }

      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── 2. Metric Router (Natural Language → Metric) ───

/**
 * 模糊匹配自然语言到指标。
 * 使用多策略匹配: 精确词组 > 别名 > CJK n-gram > 语义相似度
 *
 * @param {Object} registry — Ontology Registry
 * @param {string} query — 用户问题
 * @param {Object} [options]
 * @param {number} [options.maxResults=5]
 * @param {number} [options.minScore=0.3]
 * @returns {MetricMatchResult[]}
 */
export function routeMetric(registry, query, options = {}) {
  const { maxResults = 5, minScore = 0.3 } = options;
  const metrics = registry.listMetrics();
  const normalizedQuery = String(query || "").toLowerCase().trim();
  const results = [];

  for (const metric of metrics) {
    const labels = Object.values(metric.labels || {});
    const aliases = metric.aliases || [];

    // Strategy 1: Exact label match
    let score = 0;
    let matchedBy = null;

    for (const label of labels) {
      const normalizedLabel = String(label).toLowerCase();
      if (normalizedQuery === normalizedLabel) {
        score = 1.0;
        matchedBy = `exact:${label}`;
        break;
      }
      if (normalizedQuery.includes(normalizedLabel) && normalizedLabel.length >= 2) {
        score = Math.max(score, 0.85);
        matchedBy = `contains:${label}`;
      }
    }

    // Strategy 2: Alias match
    if (score < 0.85) {
      for (const alias of aliases) {
        const normalizedAlias = String(alias).toLowerCase();
        if (normalizedQuery.includes(normalizedAlias) && normalizedAlias.length >= 2) {
          score = Math.max(score, 0.75);
          matchedBy = `alias:${alias}`;
          break;
        }
      }
    }

    // Strategy 3: Metric ID substring match
    if (score < 0.75) {
      const idParts = metric.id.split(".");
      for (const part of idParts) {
        if (part.length >= 4 && normalizedQuery.includes(part.toLowerCase())) {
          score = Math.max(score, 0.6);
          matchedBy = `id_part:${part}`;
          break;
        }
      }
    }

    // Strategy 4: CJK n-gram fuzzy match
    if (score < 0.6) {
      const cjkLabel = metric.labels?.["zh-CN"] || "";
      if (cjkLabel.length >= 2) {
        // Bigram overlap
        const queryBigrams = extractBigrams(normalizedQuery);
        const labelBigrams = extractBigrams(cjkLabel.toLowerCase());
        const overlap = [...queryBigrams].filter((b) => labelBigrams.has(b));
        if (overlap.length > 0) {
          const jaccard = overlap.length / new Set([...queryBigrams, ...labelBigrams]).size;
          if (jaccard > 0.15) {
            score = Math.max(score, 0.4 + jaccard * 0.3);
            matchedBy = `cjk_bigram:${overlap.join("|")}`;
          }
        }
      }
    }

    // Strategy 5: Description keyword overlap
    if (score < 0.4 && metric.description) {
      const descWords = new Set(
        metric.description.toLowerCase().split(/[\s,，。;；:：()（）]+/).filter((w) => w.length >= 2)
      );
      const queryWords = new Set(
        normalizedQuery.split(/[\s,，。;；:：()（）]+/).filter((w) => w.length >= 2)
      );
      const overlap = [...queryWords].filter((w) => descWords.has(w));
      if (overlap.length >= 2) {
        score = Math.max(score, 0.35 + Math.min(0.2, overlap.length * 0.05));
        matchedBy = `keyword:${overlap.slice(0, 3).join("|")}`;
      }
    }

    if (score >= minScore) {
      results.push({
        metricId: metric.id,
        label: metric.labels?.["zh-CN"] || metric.id,
        score: Number(score.toFixed(3)),
        matchedBy,
        governanceStatus: metric.governance?.status || "unknown",
        unit: metric.unit || "count",
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function extractBigrams(text) {
  const cjkChars = text.replace(/[^\u4e00-\u9fff]/g, "");
  const bigrams = new Set();
  for (let i = 0; i < cjkChars.length - 1; i++) {
    bigrams.add(cjkChars.slice(i, i + 2));
  }
  return bigrams;
}

// ─── 3. Metric Relationship Mapper ───

/**
 * 自动推导指标之间的关系（比率、组合、时间变体等）。
 *
 * @param {Object} registry
 * @returns {MetricRelationship[]}
 */
export function deriveMetricRelationships(registry) {
  const metrics = registry.listMetrics();
  const relationships = [];

  for (const metric of metrics) {
    // Ratio relationships: numerator/denominator
    if (metric.numerator && metric.denominator) {
      relationships.push({
        type: "ratio",
        fromMetric: metric.numerator,
        toMetric: metric.denominator,
        formula: `${metric.id} = ${metric.numerator} / ${metric.denominator}`,
        description: `${metric.labels?.["zh-CN"] || metric.id} 是 ${metric.numerator} 与 ${metric.denominator} 的比值`,
      });
    }

    // Filter refinement: metrics sharing the same entity
    const sameEntityMetrics = metrics.filter((m) => m.entityId === metric.entityId && m.id !== metric.id);
    for (const other of sameEntityMetrics) {
      // Check if one is a filtered version of the other
      if (other.measure && metric.measure) {
        const otherFilterMatch = other.measure.match(/where\s+(.+?)[\s)]/i);
        const metricFilterMatch = metric.measure.match(/where\s+(.+?)[\s)]/i);
        if (otherFilterMatch && !metricFilterMatch) {
          relationships.push({
            type: "filter_refinement",
            fromMetric: metric.id,
            toMetric: other.id,
            formula: `${other.id} ⊂ ${metric.id}`,
            description: `${other.labels?.["zh-CN"] || other.id} 是 ${metric.labels?.["zh-CN"] || metric.id} 的特定条件子集`,
          });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return relationships.filter((rel) => {
    const key = `${rel.type}:${rel.fromMetric}:${rel.toMetric}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── 4. Metric Recommender ───

/**
 * 基于当前查询上下文，推荐用户可能感兴趣的后续指标。
 *
 * @param {Object} registry
 * @param {Object} context
 * @param {string[]} context.metricIds — 当前查询涉及的指标
 * @param {string} context.intent — 当前意图
 * @param {string[]} context.dimensionIds — 当前维度
 * @param {Object} [options]
 * @param {number} [options.maxRecommendations=3]
 * @returns {MetricRecommendation[]}
 */
export function recommendMetrics(registry, context, options = {}) {
  const { maxRecommendations = 3 } = options;
  const currentMetrics = new Set(context.metricIds || []);
  const currentDimensions = new Set(context.dimensionIds || []);
  const allMetrics = registry.listMetrics({ status: "approved" });
  const relationships = deriveMetricRelationships(registry);

  const scored = [];

  for (const metric of allMetrics) {
    if (currentMetrics.has(metric.id)) continue;

    let score = 0;
    const reasons = [];

    // Factor 1: Related through ratio relationships
    for (const rel of relationships) {
      if (rel.fromMetric === metric.id && currentMetrics.has(rel.toMetric)) {
        score += 0.4;
        reasons.push(`与当前指标 ${rel.toMetric} 构成 ${rel.type} 关系`);
      }
      if (rel.toMetric === metric.id && currentMetrics.has(rel.fromMetric)) {
        score += 0.4;
        reasons.push(`与当前指标 ${rel.fromMetric} 构成 ${rel.type} 关系`);
      }
    }

    // Factor 2: Same entity
    const currentEntities = new Set(
      [...currentMetrics].map((id) => {
        try { return registry.getMetric(id).entityId; } catch { return null; }
      })
    );
    if (currentEntities.has(metric.entityId)) {
      score += 0.25;
      reasons.push(`属于同一实体 ${metric.entityId}`);
    }

    // Factor 3: Dimension overlap
    const dimOverlap = (metric.allowedDimensions || []).filter((d) => currentDimensions.has(d));
    if (dimOverlap.length) {
      score += 0.15 + Math.min(0.15, dimOverlap.length * 0.03);
      reasons.push(`支持 ${dimOverlap.length} 个相同维度`);
    }

    // Factor 4: Intent-based boost
    const intentMetricMap = {
      aggregate: ["defect.count", "defect.created_count", "testing.run_count"],
      trend: ["defect.created_count", "defect.resolved_count", "testing.pass_rate"],
      compare: ["defect.resolve_rate", "testing.pass_rate", "defect.rejection_rate"],
      rank: ["defect.count", "defect.created_count", "team.defect_discovery_count"],
    };
    if (intentMetricMap[context.intent]?.includes(metric.id)) {
      score += 0.2;
      reasons.push(`${context.intent} 意图常用指标`);
    }

    // Factor 5: Capability bonus
    if (metric.capabilities?.trend && context.intent === "trend") {
      score += 0.1;
      reasons.push("支持趋势分析");
    }
    if (metric.capabilities?.comparison && context.intent === "compare") {
      score += 0.1;
      reasons.push("支持对比分析");
    }

    if (score > 0.1) {
      scored.push({
        metricId: metric.id,
        label: metric.labels?.["zh-CN"] || metric.id,
        score: Number(score.toFixed(3)),
        reasons,
        unit: metric.unit || "count",
        governanceStatus: metric.governance?.status || "unknown",
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxRecommendations);
}

// ─── 5. Metric Glossary Context Builder (for LLM prompt injection) ───

/**
 * 构建 LLM prompt 可用的指标上下文片段。
 * 智能裁剪: 只包含与当前查询相关的指标 + 推荐指标。
 *
 * @param {Object} registry
 * @param {Object} [queryContext]
 * @param {string} [queryContext.text] — 用户原始问题
 * @param {string[]} [queryContext.metricIds] — 已匹配的指标
 * @param {string[]} [queryContext.dimensionIds] — 已匹配的维度
 * @param {string} [queryContext.intent] — 已识别的意图
 * @returns {string} LLM prompt 片段
 */
export function buildMetricContextForPrompt(registry, queryContext = {}) {
  const { text, metricIds, dimensionIds, intent } = queryContext;

  // If we have a text query, use router to find relevant metrics
  let relevantMetricIds = new Set(metricIds || []);
  if (text && relevantMetricIds.size === 0) {
    const routed = routeMetric(registry, text, { maxResults: 5, minScore: 0.3 });
    relevantMetricIds = new Set(routed.map((r) => r.metricId));
  }

  // Add recommended metrics
  if (metricIds?.length || intent) {
    const recs = recommendMetrics(registry, {
      metricIds: [...relevantMetricIds],
      dimensionIds: dimensionIds || [],
      intent: intent || "aggregate",
    });
    for (const rec of recs) relevantMetricIds.add(rec.metricId);
  }

  // Build focused glossary
  const focusIds = relevantMetricIds.size > 0 ? [...relevantMetricIds] : null;
  const glossaryText = buildMetricGlossary(registry, { focusMetricIds: focusIds });

  // Build relationship context
  const relationships = deriveMetricRelationships(registry);
  const relevantRels = relationships.filter(
    (rel) => relevantMetricIds.has(rel.fromMetric) || relevantMetricIds.has(rel.toMetric)
  );

  let contextText = glossaryText;

  if (relevantRels.length) {
    contextText += "\n## 指标关系图\n\n";
    for (const rel of relevantRels) {
      contextText += `- ${rel.formula} — ${rel.description}\n`;
    }
  }

  // Add recommendations as suggestions
  if (metricIds?.length || intent) {
    const recs = recommendMetrics(registry, {
      metricIds: metricIds || [],
      dimensionIds: dimensionIds || [],
      intent: intent || "aggregate",
    });
    if (recs.length) {
      contextText += "\n## 推荐关注的后续指标\n\n";
      for (const rec of recs) {
        contextText += `- **${rec.label}** (\`${rec.metricId}\`) — ${rec.reasons.join("; ")}\n`;
      }
    }
  }

  return contextText;
}

// ─── Exports ───

/**
 * @typedef {Object} MetricMatchResult
 * @property {string} metricId
 * @property {string} label
 * @property {number} score
 * @property {string} matchedBy
 * @property {string} governanceStatus
 * @property {string} unit
 */

/**
 * @typedef {Object} MetricRecommendation
 * @property {string} metricId
 * @property {string} label
 * @property {number} score
 * @property {string[]} reasons
 * @property {string} unit
 * @property {string} governanceStatus
 */
