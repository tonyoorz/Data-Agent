import { validateSemanticFrame } from "./semanticFrame.mjs";
import { resolveTimeScopes } from "./timeResolver.mjs";
import { mandatoryScopeFilters } from "./scopePolicy.mjs";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isEllipticalFollowUp(query, priorFrame) {
  if (!priorFrame) return false;
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 80) return false;
  return /^(那|那么|再|然后|接着|同样|改成|换成|按|只看|what about\b|and\b|then\b|same\b)/i.test(text)
    || /(?:呢|怎么样|如何)[？?]?$/u.test(text);
}

function includesCatalogPhrase(text, phrase) {
  const normalizedText = String(text || "").toLocaleLowerCase("zh-CN");
  const normalizedPhrase = String(phrase || "").toLocaleLowerCase("zh-CN");
  let offset = 0;
  while (normalizedPhrase && offset < normalizedText.length) {
    const index = normalizedText.indexOf(normalizedPhrase, offset);
    if (index < 0) return false;
    const before = normalizedText[index - 1] || "";
    const after = normalizedText[index + normalizedPhrase.length] || "";
    const asciiWord = (value) => /[a-z0-9_]/i.test(value);
    if ((!asciiWord(normalizedPhrase[0]) || !asciiWord(before)) && (!asciiWord(normalizedPhrase.at(-1)) || !asciiWord(after))) return true;
    offset = index + 1;
  }
  return false;
}

function mentionedEntityIds(query, registry, matchedTerms) {
  const catalogMatches = registry.bundle.entities.filter((entity) => [
    entity.id,
    entity.id.split(".").at(-1),
    ...Object.values(entity.labels || {}),
    ...(entity.aliases || []),
  ].some((phrase) => includesCatalogPhrase(query, phrase))).map((entity) => entity.id);
  return unique([...catalogMatches, ...matchedTerms.map((term) => term.resolution.entityId)]);
}

function compatiblePriorFrame(priorFrame, registry) {
  if (!priorFrame || priorFrame.schemaFingerprint !== registry.fingerprint || priorFrame.ontologyVersion !== registry.version) return null;
  return priorFrame;
}

function mergeEquivalentFilters(filters) {
  const merged = new Map();
  for (const item of filters) {
    const key = `${item.dimensionId}\u0000${item.operator}\u0000${item.source}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...item, values: [...item.values] });
      continue;
    }
    const seen = new Set(current.values.map((value) => JSON.stringify(value)));
    for (const value of item.values) {
      const encoded = JSON.stringify(value);
      if (!seen.has(encoded)) {
        current.values.push(value);
        seen.add(encoded);
      }
    }
  }
  return [...merged.values()];
}

function intentFrom(query) {
  if (/查重|相似缺陷|重复缺陷|duplicate|similar defect/i.test(query)) return "similarity";
  if (/追溯|链路|trace|traceability/i.test(query)) return "trace";
  if (/对比|比较|相比|差异|\bcompare\b|\bvs\.?\b|versus|(?:本周|这周|本月|这个月|今年|去年|20\d{2}\s*年?)\s*比\s*(?:上周|上月|上个月|去年|今年|20\d{2})/i.test(query)) return "compare";
  if (/趋势|变化|走势|trend/i.test(query)) return "trend";
  if (/top\s*\d*|排名|排行|高频|最多|rank/i.test(query)) return "rank";
  if (/明细|列表|逐条|list|details?/i.test(query)) return "list";
  return "aggregate";
}

function defaultMetricId(query, intent) {
  if (intent === "similarity" || intent === "trace") return null;
  if (/测试执行|测试运行|manual run|run count/i.test(query)) return "testing.run_count";
  if (/测试用例|用例数量|testcase/i.test(query)) return "testing.testcase_count";
  if (/通过的测试|passed runs?/i.test(query)) return "testing.passed_run_count";
  if (/失败的测试|failed runs?/i.test(query)) return "testing.failed_run_count";
  if (/新增|新建|提交|创建|高频|created/i.test(query)) return "defect.created_count";
  return "defect.count";
}

function topLimit(query, maximum = 200) {
  const match = /(?:top|前|最多(?:的)?|排名\s*前?)\s*([一二两三四五六七八九十百\d]{1,3})\s*个?/i.exec(query);
  if (!match) return 20;
  const chinese = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const value = /^\d+$/.test(match[1]) ? Number(match[1]) : chinese[match[1]];
  return Math.min(maximum, Math.max(1, value || 20));
}

function ambiguityForMetric(metric) {
  const codeByMetric = {
    "defect.resolved_count": "RESOLVED_OUTCOME_DEFINITION_UNAPPROVED",
    "defect.open_count": "OPEN_STATUS_DEFINITION_UNAPPROVED",
    "defect.resolve_rate": "RESOLUTION_RATE_DENOMINATOR_UNAPPROVED",
    "quality.defect_density": "DEFECT_DENSITY_DENOMINATOR_REQUIRED",
    "testing.pass_rate": "TEST_RUN_DENOMINATOR_UNAPPROVED",
    "testing.fail_rate": "TEST_RUN_DENOMINATOR_UNAPPROVED",
    "testing.requirement_coverage_rate": "COVERAGE_POPULATION_UNAPPROVED",
    "defect.long_runner_count": "LONG_RUNNER_THRESHOLD_UNAPPROVED",
    "defect.age_days": "DEFECT_AGE_RULE_UNAPPROVED",
    "team.discovery_efficiency": "DISCOVERY_EFFICIENCY_FORMULA_UNAPPROVED",
  };
  const approvedFallbackByMetric = {
    "defect.resolved_count": "defect.count",
    "defect.rejected_count": "defect.count",
    "defect.open_count": "defect.count",
    "defect.resolve_rate": "defect.count",
    "defect.rejection_rate": "defect.count",
    "defect.age_days": "defect.count",
    "defect.long_runner_count": "defect.count",
    "defect.repeat_rate": "defect.count",
    "quality.defect_density": "defect.count",
    "testing.pass_rate": "testing.run_count",
    "testing.fail_rate": "testing.run_count",
    "testing.traceability_rate": "testing.run_count",
    "testing.requirement_coverage_rate": "testing.testcase_count",
    "team.discovery_efficiency": "team.execution_count",
  };
  const code = codeByMetric[metric.id] || "METRIC_DEFINITION_UNAPPROVED";
  const fallbackMetricId = approvedFallbackByMetric[metric.id] || "defect.count";
  if (metric.id === "defect.age_days") {
    return {
      code,
      kind: "metric_definition",
      message: "请明确要衡量当前缺陷年龄、已解决缺陷的解决时长，还是 SLA 达标情况；这些口径需要分别治理。",
      metricId: metric.id,
      options: ["补充其他明确口径", "取消本次查询"],
    };
  }
  if (metric.id === "testing.requirement_coverage_rate") {
    return {
      code,
      kind: "metric_definition",
      message: "请明确要查看 Requirement coverage、TestCase coverage、Run coverage，还是端到端 Traceability coverage；每种覆盖率需要独立批准总体与分母口径。",
      metricId: metric.id,
      options: ["补充其他明确口径", "取消本次查询"],
    };
  }
  return {
    code,
    kind: "metric_definition",
    message: `“${metric.labels["zh-CN"]}”的业务口径尚未批准。请选择明确口径，或联系 ${metric.governance.owner} 完成治理。`,
    metricId: metric.id,
    options: [`改用已批准指标 (${fallbackMetricId})`, "补充其他明确口径", "取消本次查询"],
  };
}

function resolvedFilterDimension(term, entityIds, intent) {
  if (term.id === "team.dtsv" && entityIds.includes("testing.test_run") && (intent === "trace" || !entityIds.includes("quality.defect"))) {
    return "org.team";
  }
  return term.resolution.dimensionId;
}

function comparisonFrom(query, filters, timeScopes) {
  const dimensionFilter = filters.find((item) => item.source === "user" && item.values?.length >= 2);
  if (dimensionFilter) return { kind: "dimension_values", dimensionId: dimensionFilter.dimensionId, groups: unique(dimensionFilter.values.map(String)).slice(0, 2) };
  const periodGroups = timeScopes.filter((item) => item.role !== "primary").map((item) => `${item.start}/${item.end}`);
  if (periodGroups.length >= 2) return { kind: "time_periods", dimensionId: timeScopes[0].fieldId, groups: periodGroups.slice(0, 2) };
  return null;
}

function normalizePatternValue(value, normalizer) {
  const text = String(value || "").trim();
  if (normalizer === "uppercase") return text.toLocaleUpperCase("zh-CN");
  if (normalizer === "lowercase") return text.toLocaleLowerCase("zh-CN");
  return text;
}

function extractGovernedValueFilters(query, matchedTerms) {
  return matchedTerms.filter((term) => term.kind === "value_pattern").flatMap((term) => {
    const resolution = term.resolution;
    const pattern = new RegExp(resolution.valuePattern, "giu");
    const values = [];
    for (const match of String(query || "").matchAll(pattern)) {
      const value = normalizePatternValue(match[resolution.captureGroup || 0], resolution.normalizer || "identity");
      if (value && !values.includes(value)) values.push(value);
      if (values.length >= (resolution.maxMatches || 10)) break;
    }
    return values.length ? [{ dimensionId: resolution.dimensionId, operator: "in", values, source: "user" }] : [];
  });
}

function explicitGroupingForDimension(query, terms, dimensionId) {
  const phrases = terms.filter((term) => term.resolution.dimensionId === dimensionId).flatMap((term) => term.phrases);
  const groupingText = [...String(query || "").matchAll(/(?:按|根据|by)\s*([^，,。；;？?]+)/giu)].map((match) => match[1]).join(" ").toLocaleLowerCase("zh-CN");
  return phrases.some((phrase) => groupingText.includes(String(phrase).toLocaleLowerCase("zh-CN")))
    || phrases.some((phrase) => new RegExp(`(?:每个|各)\\s*${String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu").test(query));
}

function clarifiedTraceSubject(query, clarification) {
  if (clarification?.selection !== "补充其他明确口径" || !/(?:这个|该|this)\s*(?:AIDA|Requirement|需求)/iu.test(String(query || ""))) return null;
  const value = String(clarification?.text || "")
    .trim()
    .replace(/^(?:AIDA(?:\s+Requirement)?(?:\s*(?:标识|ID))?|需求(?:标识|ID))\s*(?:是|为|[:：])\s*/iu, "")
    .replace(/^["'“‘]|["'”’]$/gu, "")
    .trim();
  return value && value.length <= 200 ? value : null;
}

export function createSemanticResolver({ registry, now = () => new Date().toISOString(), onUnmatched } = {}) {
  if (!registry) throw new Error("ONTOLOGY_REGISTRY_REQUIRED");
  return Object.freeze({
    resolve({ query, actor, requestAnchorAt = now(), clarification = null, candidate = null, priorSemanticFrame = null }) {
      const clarificationText = String(clarification?.text || "").trim();
      const clarificationSelection = String(clarification?.selection || "");
      const text = [String(query || "").trim(), clarificationText].filter(Boolean).join(" ");
      if (!text) throw new Error("SEMANTIC_QUERY_REQUIRED");
      const anchorAt = new Date(requestAnchorAt).toISOString();
      const priorFrame = compatiblePriorFrame(priorSemanticFrame, registry);
      const followUp = isEllipticalFollowUp(query, priorFrame);
      const matchedTerms = registry.matchTerms(text);
      const clarificationMetricIds = unique(registry.matchTerms(clarificationText)
        .map((term) => term.resolution.metricId)
        .filter((metricId) => metricId && registry.getMetric(metricId).governance.status === "approved"));
      const clarificationOverridesMetric = clarificationSelection === "补充其他明确口径" && clarificationMetricIds.length > 0;
      const languageEntityIds = mentionedEntityIds(text, registry, matchedTerms);
      let heuristicIntent = intentFrom(text);
      const traceEntityIds = new Set(["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"]);
      const traceMentionCount = languageEntityIds.filter((entityId) => traceEntityIds.has(entityId)).length;
      if (heuristicIntent === "aggregate" && traceMentionCount >= 2 && /关联|链路|追溯|哪些|没有|到|related|linked|without|which/i.test(text)) {
        heuristicIntent = "trace";
      }
      const candidateIntent = candidate?.intent;
      const hasExplicitMetric = matchedTerms.some((term) => term.resolution.metricId);
      const intent = heuristicIntent === "aggregate"
        ? followUp && !hasExplicitMetric ? priorFrame.intent : candidateIntent || heuristicIntent
        : heuristicIntent;
      const candidateMetricIds = unique(candidate?.metricIds || []).map((id) => registry.getMetric(id).id);
      let matchedMetricIds = unique(matchedTerms.map((term) => term.resolution.metricId));
      if (clarificationOverridesMetric) matchedMetricIds = clarificationMetricIds;
      const heuristicMetricId = defaultMetricId(text, intent);
      if (heuristicMetricId === "defect.created_count" && matchedMetricIds.length === 1 && matchedMetricIds[0] === "defect.count") {
        matchedMetricIds = [heuristicMetricId];
      }
      const inheritedMetricIds = followUp ? unique(priorFrame.metricIds || []).map((id) => registry.getMetric(id).id) : [];
      const usingInheritedMetric = matchedMetricIds.length === 0 && inheritedMetricIds.length > 0;
      let metricIds = matchedMetricIds.length ? matchedMetricIds : inheritedMetricIds.length ? inheritedMetricIds : candidateMetricIds;
      if (!metricIds.length) metricIds = unique([heuristicMetricId]);
      const traceRunStatus = intent === "trace" && metricIds.includes("testing.failed_run_count")
        ? "Failed"
        : intent === "trace" && metricIds.includes("testing.passed_run_count") ? "Passed" : null;
      if (intent === "trace") metricIds = [];
      const selectedFallback = /\(([a-z][a-z0-9_.]+)\)/i.exec(clarificationSelection)?.[1];
      if (selectedFallback) {
        registry.getMetric(selectedFallback, { approvedOnly: true });
        metricIds = [selectedFallback];
      }
      const metrics = metricIds.map((id) => registry.getMetric(id));
      const candidateEntityIds = unique(candidate?.entityIds || []).map((id) => registry.getEntity(id).id);
      const entityIds = unique([
        ...metrics.map((metric) => metric.entityId),
        ...matchedTerms.map((term) => term.resolution.entityId),
        ...(usingInheritedMetric ? priorFrame.entityIds || [] : []),
        ...candidateEntityIds,
        intent === "similarity" ? "quality.defect" : null,
        ...(intent === "trace" ? ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"] : []),
      ]);
      const metricAllowedDimensions = new Set(metrics.flatMap((metric) => metric.allowedDimensions || []));
      const matchedTermIds = new Set(matchedTerms.map((term) => term.id));
      const inferredPatternTerms = registry.bundle.terms.filter((term) => term.kind === "value_pattern"
        && !matchedTermIds.has(term.id)
        && metricAllowedDimensions.has(term.resolution.dimensionId));
      const governedValueFilters = extractGovernedValueFilters(text, [...matchedTerms, ...inferredPatternTerms]);
      const traceSubjectValue = intent === "trace" ? clarifiedTraceSubject(query, clarification) : null;
      const governedValueDimensions = new Set(governedValueFilters.map((item) => item.dimensionId));
      const matchedDimensionIds = (intent === "trace" ? [] : unique(matchedTerms
          .filter((term) => term.resolution.filterValue === undefined || intent === "compare")
          .map((term) => term.resolution.dimensionId)))
        .filter((dimensionId) => !governedValueDimensions.has(dimensionId) || intent === "compare" || explicitGroupingForDimension(text, matchedTerms, dimensionId));
      const candidateDimensionIds = unique(candidate?.dimensionIds || []).map((id) => registry.getDimension(id).id)
        .filter((dimensionId) => !governedValueDimensions.has(dimensionId) || intent === "compare" || explicitGroupingForDimension(text, matchedTerms, dimensionId));
      const inheritedDimensionIds = usingInheritedMetric ? unique(priorFrame.dimensionIds || []).map((id) => registry.getDimension(id).id) : [];
      let dimensionIds = unique([
        ...(matchedDimensionIds.length ? matchedDimensionIds : inheritedDimensionIds.length ? inheritedDimensionIds : candidateDimensionIds),
        intent === "rank" && /高频|模块|ECU/i.test(text) ? "product.ecu" : null,
        ...(intent === "compare" ? governedValueFilters.filter((item) => item.values.length >= 2).map((item) => item.dimensionId) : []),
      ]);
      const userFilters = [...matchedTerms
        .filter((term) => term.resolution.dimensionId && term.resolution.filterValue !== undefined)
        .map((term) => ({
          dimensionId: resolvedFilterDimension(term, entityIds, intent),
          operator: "in",
          values: [term.resolution.filterValue],
          source: "user",
        })), ...governedValueFilters, ...(traceRunStatus ? [{ dimensionId: "testing.run_status", operator: "in", values: [traceRunStatus], source: "user" }] : []), ...(traceSubjectValue ? [{ dimensionId: "requirements.aida", operator: "in", values: [traceSubjectValue], source: "user" }] : [])];
      const overriddenDimensions = new Set(userFilters.map((item) => item.dimensionId));
      const inheritedFilters = usingInheritedMetric
        ? (priorFrame.filters || [])
            .filter((item) => item.source !== "policy" && !overriddenDimensions.has(item.dimensionId))
            .filter((item) => !metrics.length || metrics.every((metric) => metric.allowedDimensions.includes(item.dimensionId)))
            .map((item) => ({ ...item, values: [...item.values], source: "context" }))
        : [];
      const filters = mergeEquivalentFilters([...inheritedFilters, ...userFilters, ...mandatoryScopeFilters(actor, entityIds, intent, registry)]);

      const untracedTestcases = intent === "trace" && filters.some((item) => item.dimensionId === "testing.trace_status" && item.values.includes("Untraced"));
      const defaultTimeDimension = metrics[0]?.defaultTimeDimension || (intent === "trace" && !untracedTestcases ? "time.test_finished_date" : null);
      const resolvedTime = resolveTimeScopes({ query: text, fieldId: defaultTimeDimension, anchorAt });
      const canInheritTime = usingInheritedMetric
        && (priorFrame.timeScopes || []).length > 0
        && (resolvedTime.assumptions.includes("TIME_DEFAULTS_TO_ANCHOR_YEAR_TO_DATE") || resolvedTime.timeScopes.length === 0)
        && priorFrame.timeScopes.every((scope) => !defaultTimeDimension || scope.fieldId === defaultTimeDimension);
      const timeScopes = canInheritTime ? priorFrame.timeScopes.map((scope) => ({ ...scope })) : resolvedTime.timeScopes;
      const assumptions = canInheritTime
        ? [...resolvedTime.assumptions.filter((item) => item !== "TIME_DEFAULTS_TO_ANCHOR_YEAR_TO_DATE"), "THREAD_SEMANTIC_CONTEXT_INHERITED"]
        : resolvedTime.assumptions;
      const ambiguitiesByCode = new Map();
      for (const term of matchedTerms) {
        if (!term.resolution.ambiguityCode) continue;
        if (selectedFallback && term.resolution.metricId !== selectedFallback) continue;
        if (clarificationOverridesMetric && term.resolution.metricId && !clarificationMetricIds.includes(term.resolution.metricId)) continue;
        const metric = term.resolution.metricId ? registry.getMetric(term.resolution.metricId) : null;
        const ambiguity = metric ? ambiguityForMetric(metric) : {
          code: term.resolution.ambiguityCode,
          kind: "intent",
          message: `“${term.phrases[0]}”需要进一步澄清。`,
          options: ["补充其他明确口径", "取消本次查询"],
        };
        ambiguitiesByCode.set(ambiguity.code, ambiguity);
      }
      for (const metric of metrics) {
        if (metric.governance.status !== "approved") {
          const ambiguity = ambiguityForMetric(metric);
          ambiguitiesByCode.set(ambiguity.code, ambiguity);
        }
      }
      if (intent === "trace" && clarificationSelection !== "查看当前授权范围的追溯概览" && /(?:这个|该|this)\s*(?:AIDA|Requirement|需求)/iu.test(text) && !filters.some((item) => item.source !== "policy" && item.dimensionId === "requirements.aida")) {
        ambiguitiesByCode.set("TRACE_SUBJECT_REQUIRED", {
          code: "TRACE_SUBJECT_REQUIRED",
          kind: "dimension",
          message: "请提供要追溯的 AIDA Requirement 标识，或先在当前 Thread 中明确该 Requirement。",
          dimensionId: "requirements.aida",
          options: ["补充其他明确口径", "查看当前授权范围的追溯概览", "取消本次查询"],
        });
      }
      const comparison = intent === "compare" ? comparisonFrom(text, filters, timeScopes) : null;
      const comparisonTrend = intent === "compare" && comparison?.kind === "dimension_values" && /趋势|走势|trend/i.test(text);
      if ((intent === "trend" || comparison?.kind === "time_periods" || comparisonTrend) && defaultTimeDimension) {
        dimensionIds = unique([...dimensionIds, defaultTimeDimension]);
      }
      for (const metric of metrics) {
        for (const dimensionId of dimensionIds) {
          if (!metric.allowedDimensions.includes(dimensionId)) {
            throw new Error(`SEMANTIC_DIMENSION_NOT_ALLOWED:${metric.id}:${dimensionId}`);
          }
        }
        for (const filter of filters) {
          if (!metric.allowedDimensions.includes(filter.dimensionId)) {
            const dimension = registry.getDimension(filter.dimensionId);
            ambiguitiesByCode.set(`FILTER_DIMENSION_NOT_AVAILABLE:${metric.id}:${filter.dimensionId}`, {
              code: "FILTER_DIMENSION_NOT_AVAILABLE",
              kind: "dimension",
              message: `“${metric.labels["zh-CN"]}”的已治理数据源不提供“${dimension.labels["zh-CN"]}”筛选。请选择该指标支持的维度。`,
              dimensionId: filter.dimensionId,
              options: ["补充其他明确口径", "取消本次查询"],
            });
          }
        }
      }
      if (intent === "compare" && !comparison) {
        ambiguitiesByCode.set("COMPARISON_GROUPS_REQUIRED", {
          code: "COMPARISON_GROUPS_REQUIRED",
          kind: "dimension",
          message: "请明确要比较的两个时间段或维度值。",
          options: ["补充其他明确口径", "取消本次查询"],
        });
      }

      const maximumLimit = registry.getConstraint("query.max_limit").parameters.maximum;
      const timeSeries = intent === "trend" || comparison?.kind === "time_periods" || comparisonTrend;
      const frame = validateSemanticFrame({
        schemaVersion: "1.0",
        ontologyVersion: registry.version,
        schemaFingerprint: registry.fingerprint,
        requestAnchorAt: anchorAt,
        intent,
        entityIds,
        metricIds,
        dimensionIds,
        filters,
        timeScopes,
        comparison,
        sort: timeSeries && defaultTimeDimension
          ? [{ fieldId: defaultTimeDimension, direction: "asc" }]
          : intent === "rank" && metricIds[0] ? [{ fieldId: metricIds[0], direction: "desc" }] : [],
        limit: timeSeries ? maximumLimit : topLimit(text, maximumLimit),
        ambiguities: [...ambiguitiesByCode.values()],
        assumptions,
        confidence: Math.max(0, Math.min(1, 0.72 + Math.min(0.22, matchedTerms.length * 0.04) - (ambiguitiesByCode.size ? 0.25 : 0))),
      });
      // Ontology-evolution signal (FAOS-style learn-from-usage loop): when a metric-bearing
      // question matches zero governed vocabulary terms, surface it so stewards can decide
      // whether a new term/metric is warranted. Trace/similarity intents and follow-ups are
      // intentionally excluded; the caller is responsible for privacy-safe logging.
      if (typeof onUnmatched === "function" && matchedTerms.length === 0 && !followUp
        && intent !== "trace" && intent !== "similarity" && !selectedFallback && !clarificationOverridesMetric) {
        onUnmatched({ query: text, intent, heuristicMetric: metricIds[0] || null });
      }
      return frame;
    },
  });
}
