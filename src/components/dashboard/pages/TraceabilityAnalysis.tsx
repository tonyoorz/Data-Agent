import { useEffect, useMemo, useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, GitBranch, Link2, Loader2, Route, ShieldAlert } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const numberFormatter = new Intl.NumberFormat("en-US");

type TraceabilitySummary = {
  total_runs: number;
  traced_runs: number;
  total_testcases: number;
  traced_testcases: number;
  traceability_rate: number;
  feature_count: number;
  story_count: number;
  defect_count: number;
  relation_rows: number;
};

type TraceabilityRelationTypeRow = {
  relation_type: string;
  run_count: number;
  testcase_count: number;
  related_count: number;
};

type TraceabilityStatusRow = {
  status: string;
  total_runs: number;
  traced_runs: number;
};

type TraceabilityRelatedItemRow = {
  relation_type: string;
  related_id: string;
  related_name: string;
  parent_name: string;
  run_count: number;
  testcase_count: number;
  failed_runs: number;
  passed_runs: number;
};

type TraceabilityChainRow = {
  epic_ids: string;
  epic_names: string;
  feature_ids: string;
  feature_names: string;
  story_ids: string;
  story_names: string;
  defect_ids: string;
  defect_names: string;
  test_id: string;
  test_name: string;
  run_id: string;
  run_status: string;
  scope_team: string;
  scope_release: string;
};

type TraceabilityTestcaseRow = {
  test_id: string;
  test_name: string;
  run_count: number;
  relation_count: number;
  feature_count: number;
  story_count: number;
  defect_count: number;
};

type TraceabilityGapRow = {
  test_id: string;
  test_name: string;
  run_count: number;
  latest_status: string;
  project: string;
  team: string;
};

type TraceabilityGraphNode = {
  id: string;
  type: string;
  label: string;
  secondary_label: string;
  status: string;
  count: number;
  title?: string;
};

type TraceabilityGraphEdge = {
  id: string;
  from: string;
  to: string;
  count: number;
};

type TraceabilityGraphPayload = {
  layers: string[];
  nodes: TraceabilityGraphNode[];
  edges: TraceabilityGraphEdge[];
};

type TraceabilityFilterOptions = {
  years: string[];
  teams: string[];
  releases: string[];
  weeks: string[];
  statuses: string[];
  relation_types: string[];
};

type TraceabilityPayload = {
  summary: TraceabilitySummary;
  filter_options?: TraceabilityFilterOptions;
  relation_type_rows: TraceabilityRelationTypeRow[];
  status_rows: TraceabilityStatusRow[];
  top_related_items: TraceabilityRelatedItemRow[];
  traceability_chain_rows?: TraceabilityChainRow[];
  graph?: TraceabilityGraphPayload;
  testcase_rows: TraceabilityTestcaseRow[];
  gap_rows: TraceabilityGapRow[];
};

const TRACEABILITY_FILTER_STORAGE_KEY = "vizion.traceability.filters";

function readStoredTraceabilityFilters() {
  if (typeof window === "undefined") {
    return { release: "", week: "" };
  }

  try {
    const rawValue = window.localStorage.getItem(TRACEABILITY_FILTER_STORAGE_KEY);
    if (!rawValue) {
      return { release: "", week: "" };
    }
    const parsed = JSON.parse(rawValue) as { release?: unknown; week?: unknown };
    return {
      release: typeof parsed.release === "string" ? parsed.release : "",
      week: typeof parsed.week === "string" ? parsed.week : "",
    };
  } catch {
    return { release: "", week: "" };
  }
}

function writeStoredTraceabilityFilters(release: string, week: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (!release && !week) {
      window.localStorage.removeItem(TRACEABILITY_FILTER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(TRACEABILITY_FILTER_STORAGE_KEY, JSON.stringify({ release, week }));
  } catch {
    // Ignore storage errors; the in-memory filter state still works for this page view.
  }
}

function currentYear() {
  return String(new Date().getFullYear());
}

async function fetchTraceabilityAnalysis(year: string, release = "", week = ""): Promise<TraceabilityPayload> {
  const params = new URLSearchParams({ years: year });
  if (release) {
    params.set("releases", release);
  }
  if (week) {
    params.set("weeks", week);
  }
  const response = await fetch(`/api/testing/traceability-analysis?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Traceability analysis request failed (${response.status} ${response.statusText})`);
  }

  return response.json() as Promise<TraceabilityPayload>;
}

function toPercent(value: number) {
  return `${Math.round(Number(value) || 0)}%`;
}

function releaseSortKey(release: string) {
  const match = release.match(/R-(\d{2,4})-(\d{1,2})/i);
  if (!match) {
    return { year: -1, release: -1, raw: release };
  }
  const rawYear = Number.parseInt(match[1], 10);
  return {
    year: rawYear < 100 ? rawYear + 2000 : rawYear,
    release: Number.parseInt(match[2], 10),
    raw: release,
  };
}

function resolveLatestRelease(releases: string[]) {
  return releases
    .filter(Boolean)
    .slice()
    .sort((left, right) => {
      const leftKey = releaseSortKey(left);
      const rightKey = releaseSortKey(right);
      return (
        leftKey.year - rightKey.year ||
        leftKey.release - rightKey.release ||
        leftKey.raw.localeCompare(rightKey.raw)
      );
    })
    .at(-1) ?? "";
}

const GRAPH_LAYER_LABELS: Record<string, string> = {
  epic: "Epic",
  feature: "Feature",
  story: "Story",
  testcase: "Testcase",
  manual_run: "Manual Run",
  defect: "Defect",
};

const GRAPH_LAYERS = ["epic", "feature", "story", "testcase", "manual_run", "defect"];
const GRAPH_NODE_WIDTH = 248;
const GRAPH_NODE_VERTICAL_STEP = 54;
const GRAPH_NODE_TOP = 56;

function splitTraceValues(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function pairTraceIdsAndNames(ids: string, names: string) {
  const idValues = splitTraceValues(ids);
  const nameValues = splitTraceValues(names);
  return idValues.map((id, index) => ({ id, name: nameValues[index] || id }));
}

function buildTraceabilityGraphFromChainRows(rows: TraceabilityChainRow[]): TraceabilityGraphPayload {
  const nodesById = new Map<string, TraceabilityGraphNode>();
  const edgesById = new Map<string, TraceabilityGraphEdge>();

  function addNode(type: string, rawId: string, label: string, secondaryLabel = rawId, status = "") {
    const id = `${type}:${rawId}`;
    const current = nodesById.get(id);
    if (current) {
      current.count += 1;
      if (!current.status && status) {
        current.status = status;
      }
      return id;
    }

    nodesById.set(id, {
      id,
      type,
      label: label || rawId,
      secondary_label: secondaryLabel || rawId,
      status,
      count: 1,
    });
    return id;
  }

  function addEdge(from: string, to: string) {
    if (!from || !to) {
      return;
    }
    const id = `${from}->${to}`;
    const current = edgesById.get(id);
    if (current) {
      current.count += 1;
      return;
    }

    edgesById.set(id, { id, from, to, count: 1 });
  }

  rows.forEach((row) => {
    const epicNodes = pairTraceIdsAndNames(row.epic_ids, row.epic_names).map((item) =>
      addNode("epic", item.id, item.name),
    );
    const featureNodes = pairTraceIdsAndNames(row.feature_ids, row.feature_names).map((item) =>
      addNode("feature", item.id, item.name),
    );
    const storyNodes = pairTraceIdsAndNames(row.story_ids, row.story_names).map((item) =>
      addNode("story", item.id, item.name),
    );
    const defectNodes = pairTraceIdsAndNames(row.defect_ids, row.defect_names).map((item) =>
      addNode("defect", item.id, item.name),
    );
    const testcaseNode = row.test_id
      ? addNode("testcase", row.test_id, row.test_name || row.test_id, row.test_id)
      : "";
    const manualRunNode = row.run_id
      ? addNode("manual_run", row.run_id, row.test_name || row.run_id, row.run_id, row.run_status)
      : "";

    epicNodes.forEach((epicNode) => featureNodes.forEach((featureNode) => addEdge(epicNode, featureNode)));
    (featureNodes.length ? featureNodes : epicNodes).forEach((parentNode) =>
      storyNodes.forEach((storyNode) => addEdge(parentNode, storyNode)),
    );
    (storyNodes.length ? storyNodes : featureNodes.length ? featureNodes : epicNodes).forEach((parentNode) =>
      addEdge(parentNode, testcaseNode),
    );
    addEdge(testcaseNode, manualRunNode);
    const defectParentNode = manualRunNode || testcaseNode;
    defectNodes.forEach((defectNode) => addEdge(defectParentNode, defectNode));
  });

  return {
    layers: GRAPH_LAYERS,
    nodes: Array.from(nodesById.values()).sort(
      (left, right) =>
        GRAPH_LAYERS.indexOf(left.type) - GRAPH_LAYERS.indexOf(right.type) ||
        left.label.localeCompare(right.label),
    ),
    edges: Array.from(edgesById.values()),
  };
}

function getGraphNodeClassName(node: TraceabilityGraphNode) {
  const status = node.status.toLowerCase();
  if (node.type === "manual_run" && status.includes("fail")) {
    return "border-red-300 bg-red-50 text-red-900 shadow-red-100";
  }
  if (node.type === "manual_run" && status.includes("pass")) {
    return "border-emerald-300 bg-emerald-50 text-emerald-900 shadow-emerald-100";
  }

  const toneByType: Record<string, string> = {
    epic: "border-slate-300 bg-slate-50 text-slate-900 shadow-slate-100",
    feature: "border-blue-300 bg-blue-50 text-blue-900 shadow-blue-100",
    story: "border-cyan-300 bg-cyan-50 text-cyan-900 shadow-cyan-100",
    defect: "border-amber-300 bg-amber-50 text-amber-950 shadow-amber-100",
    testcase: "border-indigo-300 bg-indigo-50 text-indigo-900 shadow-indigo-100",
    manual_run: "border-slate-300 bg-white text-slate-900 shadow-slate-100",
  };
  return toneByType[node.type] ?? "border-border bg-card text-foreground shadow-muted";
}

function TraceabilityGraph({
  graph,
  releaseOptions,
  selectedRelease,
  onReleaseChange,
  weekOptions,
  selectedWeek,
  onWeekChange,
  visibleChainCount,
  totalChainCount,
}: {
  graph?: TraceabilityGraphPayload;
  releaseOptions: string[];
  selectedRelease: string;
  onReleaseChange: (release: string) => void;
  weekOptions: string[];
  selectedWeek: string;
  onWeekChange: (week: string) => void;
  visibleChainCount: number;
  totalChainCount: number;
}) {
  const layers = graph?.layers?.length ? graph.layers : GRAPH_LAYERS;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set());
  const [expandedFeatureGroupIds, setExpandedFeatureGroupIds] = useState<Set<string>>(() => new Set());
  const [expandedStoryGroupIds, setExpandedStoryGroupIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCollapsedNodeIds(new Set());
    setExpandedFeatureGroupIds(new Set());
    setExpandedStoryGroupIds(new Set());
  }, [graph]);

  const compactGraph = useMemo(() => {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const edgesByFrom = new Map<string, TraceabilityGraphEdge[]>();
    edges.forEach((edge) => {
      const fromEdges = edgesByFrom.get(edge.from) ?? [];
      fromEdges.push(edge);
      edgesByFrom.set(edge.from, fromEdges);
    });

    const hiddenNodeIds = new Set<string>();
    const compactNodes = new Map(nodes.map((node) => [node.id, node]));
    const compactEdges = new Map(edges.map((edge) => [edge.id, edge]));

    const addCompactNode = (node: TraceabilityGraphNode) => compactNodes.set(node.id, node);
    const addCompactEdge = (from: string, to: string, count: number) => {
      if (!from || !to || count <= 0) {
        return;
      }
      const id = `${from}->${to}`;
      compactEdges.set(id, { id, from, to, count });
    };
    const removeHiddenEdges = () => {
      edges.forEach((edge) => {
        if (hiddenNodeIds.has(edge.from) || hiddenNodeIds.has(edge.to)) {
          compactEdges.delete(edge.id);
        }
      });
    };
    const formatGroupedLabel = (items: TraceabilityGraphNode[], fallback: string) => {
      const first = items[0]?.label || fallback;
      return items.length > 1 ? `${first} +${numberFormatter.format(items.length - 1)}` : first;
    };
    const summarizeCaseStatuses = (testcaseIds: Set<string>) =>
      Array.from(testcaseIds)
        .map((testcaseId) => {
          const testcase = nodesById.get(testcaseId);
          const statuses = new Map<string, number>();
          (edgesByFrom.get(testcaseId) ?? []).forEach((edge) => {
            const runNode = nodesById.get(edge.to);
            if (runNode?.type !== "manual_run") {
              return;
            }
            const status = runNode.status || "Unknown";
            statuses.set(status, (statuses.get(status) ?? 0) + 1);
          });
          const statusText = Array.from(statuses.entries())
            .map(([status, count]) => `${status}: ${count}`)
            .join(", ") || "No runs";
          return `${testcase?.label || testcaseId} (${statusText})`;
        })
        .join("\n");
    const collectStoryDownstream = (storyIds: Set<string>) => {
      const testcaseIds = new Set<string>();
      const manualRunIds = new Set<string>();
      const defectIds = new Set<string>();
      storyIds.forEach((storyId) => {
        (edgesByFrom.get(storyId) ?? []).forEach((edge) => {
          if (nodesById.get(edge.to)?.type === "testcase") {
            testcaseIds.add(edge.to);
          }
        });
      });
      testcaseIds.forEach((testcaseId) => {
        (edgesByFrom.get(testcaseId) ?? []).forEach((edge) => {
          if (nodesById.get(edge.to)?.type === "manual_run") {
            manualRunIds.add(edge.to);
          }
        });
      });
      manualRunIds.forEach((manualRunId) => {
        (edgesByFrom.get(manualRunId) ?? []).forEach((edge) => {
          if (nodesById.get(edge.to)?.type === "defect") {
            defectIds.add(edge.to);
          }
        });
      });
      return { testcaseIds, manualRunIds, defectIds };
    };
    const hideDownstream = (storyIds: Set<string>, includeStories: boolean) => {
      const { testcaseIds, manualRunIds, defectIds } = collectStoryDownstream(storyIds);
      if (includeStories) {
        storyIds.forEach((storyId) => hiddenNodeIds.add(storyId));
      }
      testcaseIds.forEach((testcaseId) => hiddenNodeIds.add(testcaseId));
      manualRunIds.forEach((manualRunId) => hiddenNodeIds.add(manualRunId));
      defectIds.forEach((defectId) => hiddenNodeIds.add(defectId));
      return { testcaseIds, manualRunIds, defectIds };
    };

    const featureNodes = nodes.filter((node) => node.type === "feature");
    featureNodes.forEach((featureNode) => {
      const storyIds = new Set(
        (edgesByFrom.get(featureNode.id) ?? [])
          .filter((edge) => nodesById.get(edge.to)?.type === "story")
          .map((edge) => edge.to),
      );
      if (storyIds.size === 0 || expandedFeatureGroupIds.has(featureNode.id)) {
        return;
      }
      const storyNodes = Array.from(storyIds).map((storyId) => nodesById.get(storyId)).filter(Boolean) as TraceabilityGraphNode[];
      const { testcaseIds, manualRunIds, defectIds } = hideDownstream(storyIds, true);
      const testcaseNodes = Array.from(testcaseIds).map((id) => nodesById.get(id)).filter(Boolean) as TraceabilityGraphNode[];
      const runNodes = Array.from(manualRunIds).map((id) => nodesById.get(id)).filter(Boolean) as TraceabilityGraphNode[];
      const defectNodes = Array.from(defectIds).map((id) => nodesById.get(id)).filter(Boolean) as TraceabilityGraphNode[];
      const storyGroupId = `story_group:${featureNode.id}`;
      const testcaseGroupId = `testcase_group:${featureNode.id}`;
      const manualRunGroupId = `manual_run_group:${featureNode.id}`;
      const defectGroupId = `defect_group:${featureNode.id}`;
      const storyTitle = [
        `Feature: ${featureNode.label}`,
        `Stories: ${storyNodes.length}`,
        ...storyNodes.map((story) => `- ${story.label}`),
      ].filter(Boolean).join("\n");
      const testcaseTitle = [
        `Feature: ${featureNode.label}`,
        `Testcases: ${testcaseNodes.length}`,
        summarizeCaseStatuses(testcaseIds),
      ].filter(Boolean).join("\n");
      const runStatusSummary = new Map<string, number>();
      runNodes.forEach((runNode) => runStatusSummary.set(runNode.status || "Unknown", (runStatusSummary.get(runNode.status || "Unknown") ?? 0) + 1));
      const runTitle = [
        `Feature: ${featureNode.label}`,
        `Runs: ${runNodes.length}`,
        ...Array.from(runStatusSummary.entries()).map(([status, count]) => `${status}: ${count}`),
        ...runNodes.slice(0, 40).map((run) => `- ${run.label}${run.status ? ` (${run.status})` : ""}`),
      ].filter(Boolean).join("\n");
      const defectTitle = [
        `Feature: ${featureNode.label}`,
        `Defects: ${defectNodes.length}`,
        ...defectNodes.map((defect) => `- ${defect.label}`),
      ].filter(Boolean).join("\n");
      addCompactNode({ id: storyGroupId, type: "story", label: formatGroupedLabel(storyNodes, "Story set"), secondary_label: featureNode.secondary_label, status: "Grouped", count: storyIds.size, title: storyTitle });
      addCompactNode({ id: testcaseGroupId, type: "testcase", label: formatGroupedLabel(testcaseNodes, "Testcase set"), secondary_label: featureNode.secondary_label, status: "Grouped", count: testcaseIds.size, title: testcaseTitle });
      addCompactNode({ id: manualRunGroupId, type: "manual_run", label: formatGroupedLabel(runNodes, "Run set"), secondary_label: featureNode.secondary_label, status: "Grouped", count: manualRunIds.size, title: runTitle });
      addCompactEdge(featureNode.id, storyGroupId, storyIds.size);
      addCompactEdge(storyGroupId, testcaseGroupId, testcaseIds.size);
      addCompactEdge(testcaseGroupId, manualRunGroupId, manualRunIds.size);
      if (defectIds.size > 0) {
        addCompactNode({ id: defectGroupId, type: "defect", label: formatGroupedLabel(defectNodes, "Defect set"), secondary_label: featureNode.secondary_label, status: "Grouped", count: defectIds.size, title: defectTitle });
        addCompactEdge(manualRunGroupId, defectGroupId, defectIds.size);
      }
    });

    const storyNodes = nodes.filter((node) => node.type === "story" && !hiddenNodeIds.has(node.id));
    storyNodes.forEach((storyNode) => {
      if (expandedStoryGroupIds.has(storyNode.id)) {
        return;
      }
      const storyIds = new Set([storyNode.id]);
      const { testcaseIds, manualRunIds, defectIds } = hideDownstream(storyIds, false);
      if (testcaseIds.size === 0) {
        return;
      }
      const testcaseNodes = Array.from(testcaseIds).map((id) => nodesById.get(id)).filter(Boolean) as TraceabilityGraphNode[];
      const runNodes = Array.from(manualRunIds).map((id) => nodesById.get(id)).filter(Boolean) as TraceabilityGraphNode[];
      const defectNodes = Array.from(defectIds).map((id) => nodesById.get(id)).filter(Boolean) as TraceabilityGraphNode[];
      const testcaseGroupId = `testcase_group:${storyNode.id}`;
      const manualRunGroupId = `manual_run_group:${storyNode.id}`;
      const defectGroupId = `defect_group:${storyNode.id}`;
      const testcaseTitle = [
        `Story: ${storyNode.label}`,
        `Testcases: ${testcaseNodes.length}`,
        summarizeCaseStatuses(testcaseIds),
      ].filter(Boolean).join("\n");
      const runStatusSummary = new Map<string, number>();
      runNodes.forEach((runNode) => runStatusSummary.set(runNode.status || "Unknown", (runStatusSummary.get(runNode.status || "Unknown") ?? 0) + 1));
      const runTitle = [
        `Story: ${storyNode.label}`,
        `Runs: ${runNodes.length}`,
        ...Array.from(runStatusSummary.entries()).map(([status, count]) => `${status}: ${count}`),
        ...runNodes.slice(0, 40).map((run) => `- ${run.label}${run.status ? ` (${run.status})` : ""}`),
      ].filter(Boolean).join("\n");
      const defectTitle = [
        `Story: ${storyNode.label}`,
        `Defects: ${defectNodes.length}`,
        ...defectNodes.map((defect) => `- ${defect.label}`),
      ].filter(Boolean).join("\n");
      addCompactNode({ id: testcaseGroupId, type: "testcase", label: formatGroupedLabel(testcaseNodes, "Testcase set"), secondary_label: storyNode.secondary_label, status: "Grouped", count: testcaseIds.size, title: testcaseTitle });
      addCompactNode({ id: manualRunGroupId, type: "manual_run", label: formatGroupedLabel(runNodes, "Run set"), secondary_label: storyNode.secondary_label, status: "Grouped", count: manualRunIds.size, title: runTitle });
      addCompactEdge(storyNode.id, testcaseGroupId, testcaseIds.size);
      addCompactEdge(testcaseGroupId, manualRunGroupId, manualRunIds.size);
      if (defectIds.size > 0) {
        addCompactNode({ id: defectGroupId, type: "defect", label: formatGroupedLabel(defectNodes, "Defect set"), secondary_label: storyNode.secondary_label, status: "Grouped", count: defectIds.size, title: defectTitle });
        addCompactEdge(manualRunGroupId, defectGroupId, defectIds.size);
      }
    });

    removeHiddenEdges();
    hiddenNodeIds.forEach((nodeId) => compactNodes.delete(nodeId));
    return {
      nodes: Array.from(compactNodes.values()),
      edges: Array.from(compactEdges.values()).filter((edge) => compactNodes.has(edge.from) && compactNodes.has(edge.to)),
    };
  }, [edges, expandedFeatureGroupIds, expandedStoryGroupIds, nodes]);

  const collapsedDescendantIds = new Set<string>();
  const collectDescendants = (nodeId: string) => {
    compactGraph.edges.forEach((edge) => {
      if (edge.from !== nodeId || collapsedDescendantIds.has(edge.to)) {
        return;
      }
      collapsedDescendantIds.add(edge.to);
      collectDescendants(edge.to);
    });
  };
  collapsedNodeIds.forEach((nodeId) => collectDescendants(nodeId));
  const visibleNodes = compactGraph.nodes.filter((node) => !collapsedDescendantIds.has(node.id));
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = compactGraph.edges.filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to));
  const nodesByLayer = new Map<string, TraceabilityGraphNode[]>();
  layers.forEach((layer) => nodesByLayer.set(layer, []));
  visibleNodes.forEach((node) => {
    const layerNodes = nodesByLayer.get(node.type);
    if (layerNodes) {
      layerNodes.push(node);
    }
  });

  const width = Math.max(1580, layers.length * 300);
  const maxLayerSize = Math.max(1, ...layers.map((layer) => nodesByLayer.get(layer)?.length ?? 0));
  const height = Math.max(240, maxLayerSize * GRAPH_NODE_VERTICAL_STEP + 72);
  const horizontalStep = layers.length > 1 ? (width - 260) / (layers.length - 1) : width - 260;
  const nodePositions = new Map<string, { x: number; y: number }>();

  layers.forEach((layer, layerIndex) => {
    const layerNodes = nodesByLayer.get(layer) ?? [];
    layerNodes.forEach((node, nodeIndex) => {
      nodePositions.set(node.id, {
        x: 130 + layerIndex * horizontalStep,
        y: GRAPH_NODE_TOP + nodeIndex * GRAPH_NODE_VERTICAL_STEP,
      });
    });
  });

  const toggleCollapsedNode = (nodeId: string) => {
    if (nodeId.startsWith("story_group:")) {
      const featureId = nodeId.replace("story_group:", "");
      setExpandedFeatureGroupIds((current) => new Set(current).add(featureId));
      return;
    }

    if (nodeId.startsWith("testcase_group:") || nodeId.startsWith("manual_run_group:") || nodeId.startsWith("defect_group:")) {
      const targetId = nodeId.split(":").slice(1).join(":");
      if (targetId.startsWith("feature:")) {
        setExpandedFeatureGroupIds((current) => new Set(current).add(targetId));
        return;
      }
      if (targetId.startsWith("story:")) {
        setExpandedStoryGroupIds((current) => new Set(current).add(targetId));
        return;
      }
      return;
    }

    setCollapsedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  return (
    <section className="dashboard-card overflow-hidden" data-testid="traceability-graph">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">多层追溯图</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            显示 {visibleChainCount} / {totalChainCount} 条链路 · 默认按 Feature 聚合 Story / Testcase / MR
          </p>
        </div>
        <div className="flex items-center gap-3">
          {collapsedNodeIds.size > 0 ? (
            <button
              type="button"
              onClick={() => setCollapsedNodeIds(new Set())}
              className="h-8 rounded-md border border-border px-3 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-muted"
            >
              全部展开
            </button>
          ) : null}
          {expandedFeatureGroupIds.size > 0 || expandedStoryGroupIds.size > 0 ? (
            <button
              type="button"
              onClick={() => {
                setExpandedFeatureGroupIds(new Set());
                setExpandedStoryGroupIds(new Set());
              }}
              className="h-8 rounded-md border border-border px-3 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-muted"
            >
              恢复聚合
            </button>
          ) : null}
          {releaseOptions.length > 0 ? (
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              Release
              <select
                aria-label="Release filter"
                value={selectedRelease}
                onChange={(event) => onReleaseChange(event.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs font-semibold text-foreground shadow-sm outline-none transition-colors focus:border-primary"
              >
                {releaseOptions.map((release) => (
                  <option key={release} value={release}>
                    {release}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {weekOptions.length > 0 ? (
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              CW
              <select
                aria-label="CW filter"
                value={selectedWeek}
                onChange={(event) => onWeekChange(event.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs font-semibold text-foreground shadow-sm outline-none transition-colors focus:border-primary"
              >
                <option value="">All</option>
                {weekOptions.map((week) => (
                  <option key={week} value={week}>
                    {week}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
      <div className="overflow-x-auto p-4">
        {visibleNodes.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">暂无可视化追溯链路</div>
        ) : (
          <div className="relative" style={{ width, height }}>
            <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
              {visibleEdges.map((edge) => {
                const from = nodePositions.get(edge.from);
                const to = nodePositions.get(edge.to);
                if (!from || !to) {
                  return null;
                }
                const curveOffset = Math.max(40, (to.x - from.x) / 2);
                const path = `M ${from.x + GRAPH_NODE_WIDTH / 2} ${from.y} C ${from.x + curveOffset} ${from.y}, ${to.x - curveOffset} ${to.y}, ${to.x - GRAPH_NODE_WIDTH / 2} ${to.y}`;
                return (
                  <path
                    key={edge.id}
                    data-testid={`traceability-graph-edge-${edge.id}`}
                    d={path}
                    fill="none"
                    stroke="hsl(215, 70%, 48%)"
                    strokeLinecap="round"
                    strokeOpacity={0.36}
                    strokeWidth={Math.min(6, Math.max(1.5, edge.count + 1))}
                  />
                );
              })}
            </svg>
            {layers.map((layer, layerIndex) => (
              <div
                key={layer}
                data-testid={`traceability-graph-layer-${layer}`}
                className="absolute top-2 -translate-x-1/2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                style={{ left: 130 + layerIndex * horizontalStep, width: GRAPH_NODE_WIDTH }}
              >
                {GRAPH_LAYER_LABELS[layer] ?? layer}
              </div>
            ))}
            {visibleNodes.map((node) => {
              const position = nodePositions.get(node.id);
              if (!position) {
                return null;
              }
              const titleParts = [
                node.label,
                node.secondary_label ? `ID: ${node.secondary_label}` : "",
                node.status ? `Status: ${node.status}` : "",
                `Links: ${node.count}`,
                node.title ?? "",
                node.id.includes("_group:") ? "Click to expand this story group" : "",
              ].filter(Boolean);
              return (
                <button
                  type="button"
                  key={node.id}
                  data-testid={`traceability-graph-node-${node.id}`}
                  aria-pressed={collapsedNodeIds.has(node.id)}
                  onClick={() => toggleCollapsedNode(node.id)}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-lg border px-3 py-1.5 text-center shadow-sm outline-none transition hover:-translate-y-[calc(50%+1px)] hover:shadow-md focus:ring-2 focus:ring-primary/30 ${getGraphNodeClassName(node)}`}
                  style={{ left: position.x, top: position.y, width: GRAPH_NODE_WIDTH }}
                  title={titleParts.join("\n")}
                >
                  <p className="truncate text-[11px] font-semibold leading-5">{node.label}</p>
                  {collapsedNodeIds.has(node.id) ? (
                    <span
                      data-testid={`traceability-graph-collapse-marker-${node.id}`}
                      className="absolute right-1.5 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold leading-none text-primary-foreground"
                      aria-hidden="true"
                    >
                      +
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

const TraceabilityAnalysis = () => {
  const year = currentYear();
  const [storedFilters] = useState(readStoredTraceabilityFilters);
  const [selectedRelease, setSelectedRelease] = useState(storedFilters.release);
  const [selectedWeek, setSelectedWeek] = useState(storedFilters.week);
  const { data, error, isLoading } = useQuery({
    queryKey: ["traceability-analysis", year, selectedRelease, selectedWeek],
    queryFn: () => fetchTraceabilityAnalysis(year, selectedRelease, selectedWeek),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 0,
  });

  const summary = data?.summary ?? {
    total_runs: 0,
    traced_runs: 0,
    total_testcases: 0,
    traced_testcases: 0,
    traceability_rate: 0,
    feature_count: 0,
    story_count: 0,
    defect_count: 0,
    relation_rows: 0,
  };
  const relationTypeRows = data?.relation_type_rows ?? [];
  const statusRows = data?.status_rows ?? [];
  const traceabilityChainRows = data?.traceability_chain_rows ?? [];
  const releaseOptions = data?.filter_options?.releases ?? [];
  const weekOptions = data?.filter_options?.weeks ?? [];
  const graph = useMemo(() => {
    if (data?.graph?.nodes?.length) {
      return data.graph;
    }

    if (traceabilityChainRows.length > 0) {
      return buildTraceabilityGraphFromChainRows(traceabilityChainRows);
    }

    return buildTraceabilityGraphFromChainRows([]);
  }, [data?.graph, traceabilityChainRows]);
  const graphNodeCounts = useMemo(
    () => ({
      feature: graph.nodes.filter((node) => node.type === "feature").length,
      story: graph.nodes.filter((node) => node.type === "story").length,
      defect: graph.nodes.filter((node) => node.type === "defect").length,
    }),
    [graph.nodes],
  );
  const statusChartRows = useMemo(
    () => statusRows.map((row) => ({ ...row, untraced_runs: Math.max(row.total_runs - row.traced_runs, 0) })),
    [statusRows],
  );

  useEffect(() => {
    if (selectedRelease || releaseOptions.length === 0) {
      return;
    }

    const latestRelease = resolveLatestRelease(releaseOptions);
    if (latestRelease) {
      setSelectedRelease(latestRelease);
    }
  }, [releaseOptions, selectedRelease]);
  useEffect(() => {
    writeStoredTraceabilityFilters(selectedRelease, selectedWeek);
  }, [selectedRelease, selectedWeek]);
  useEffect(() => {
    if (!data?.filter_options || !selectedWeek || weekOptions.includes(selectedWeek)) {
      return;
    }
    setSelectedWeek("");
  }, [data?.filter_options, selectedWeek, weekOptions]);
  const kpis = [
    {
      label: "Traceability rate",
      value: toPercent(summary.traceability_rate),
      icon: Link2,
      color: "bg-primary/10 text-primary",
    },
    {
      label: "Traced runs",
      value: `${numberFormatter.format(summary.traced_runs)} / ${numberFormatter.format(summary.total_runs)}`,
      icon: Route,
      color: "bg-success/10 text-success",
    },
    {
      label: "Traced testcases",
      value: `${numberFormatter.format(summary.traced_testcases)} / ${numberFormatter.format(summary.total_testcases)}`,
      icon: GitBranch,
      color: "bg-accent/10 text-accent",
    },
    {
      label: "Feature / Story / Defect",
      value: `${numberFormatter.format(graphNodeCounts.feature)} / ${numberFormatter.format(graphNodeCounts.story)} / ${numberFormatter.format(graphNodeCounts.defect)}`,
      icon: ShieldAlert,
      color: "bg-warning/10 text-warning",
    },
  ];

  if (isLoading && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在加载测试追溯关系数据...</span>
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-start gap-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-medium">测试追溯关系数据加载失败</p>
            <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "请稍后重试"}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="dashboard-card p-5" role="article" aria-label={kpi.label}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="kpi-label">{kpi.label}</p>
                  <p className="kpi-value mt-1 break-words">{kpi.value}</p>
                </div>
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${kpi.color}`}>
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="dashboard-card p-5">
          <h3 className="mb-4 text-sm font-semibold text-foreground">关系类型覆盖</h3>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={relationTypeRows} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
                <XAxis dataKey="relation_type" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
                <Bar dataKey="run_count" name="Runs" fill="hsl(215, 70%, 48%)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="testcase_count" name="Testcases" fill="hsl(152, 60%, 40%)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="related_count" name="Related items" fill="hsl(38, 92%, 50%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="dashboard-card p-5">
          <h3 className="mb-4 text-sm font-semibold text-foreground">状态追溯覆盖</h3>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusChartRows} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
                <XAxis dataKey="status" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
                <Bar dataKey="traced_runs" name="Traced" stackId="coverage" fill="hsl(152, 60%, 40%)" />
                <Bar dataKey="untraced_runs" name="Untraced" stackId="coverage" fill="hsl(220, 16%, 60%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <TraceabilityGraph
        graph={graph}
        releaseOptions={releaseOptions}
        selectedRelease={selectedRelease}
        onReleaseChange={setSelectedRelease}
        weekOptions={weekOptions}
        selectedWeek={selectedWeek}
        onWeekChange={setSelectedWeek}
        visibleChainCount={traceabilityChainRows.length}
        totalChainCount={traceabilityChainRows.length}
      />
    </div>
  );
};

export default TraceabilityAnalysis;