// Unified Data-Agent System — the composition root that binds the three
// integrated layers into one addressable system:
//
//   L1 codex harness   server/mainAgentToolRegistry.mjs + mainAgentToolOrchestrator.mjs
//                      (tool metadata / intent profiles / policy gate + turn events)
//   L2 pi semantic     server/ontology/registry.mjs + ontology/runtimePublication.mjs
//      kernel          (fail-closed governed ontology + runtime capability publication)
//   L3 data plane      server/mainAgentTools.mjs semantic executors → FastAPI
//                      backend/analytics semantic_query.py via /api/semantic/query
//
// Contract: the harness is the only execution path, the pi kernel is the only
// semantic authority, and the data plane is only reachable through governed
// semantic tools. This module wires them together, exposes one snapshot for
// health/ops, and validates the cross-layer contracts fail-closed.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAnalyticsApiBase } from "./analyticsApiConfig.mjs";
import { MAIN_AGENT_TOOLS, executeMainAgentToolCall } from "./mainAgentTools.mjs";
import { runMainAgentToolTurn } from "./mainAgentToolOrchestrator.mjs";
import {
  createMainAgentToolRegistry,
  MAIN_AGENT_INTENT_PROFILES,
} from "./mainAgentToolRegistry.mjs";
import { createOntologyRegistry } from "./ontology/registry.mjs";
import { buildRuntimeCapabilityReport } from "./ontology/runtimePublication.mjs";

export const UNIFIED_SYSTEM_NAME = "unified-data-agent";
export const UNIFIED_SYSTEM_VERSION = "1.0.0";
export const SEMANTIC_QUERY_ENDPOINT_PATH = "/api/semantic/query";
export const UNIFIED_SEMANTIC_TOOL_NAMES = Object.freeze([
  "query_semantic_metrics",
  "query_semantic_records",
  "query_traceability",
]);

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function layerError(code, detail) {
  return { ok: false, code, detail: detail || "" };
}

function loadSemanticKernelLayer({ root, registry }) {
  try {
    const resolved = registry || createOntologyRegistry({ root });
    const report = buildRuntimeCapabilityReport(resolved.bundle, resolved.fingerprint);
    const readyMetricIds = Array.isArray(report.runtimeReadyMetricIds)
      ? report.runtimeReadyMetricIds
      : [];
    const adapterIds = Array.isArray(report.adapters)
      ? report.adapters.map((adapter) => adapter.adapterId).filter(Boolean)
      : [];
    return {
      ok: true,
      registry: resolved,
      report,
      summary: {
        layer: "pi.semantic-kernel",
        ontologyVersion: resolved.version,
        fingerprint: resolved.fingerprint,
        compilerVersion: resolved.compilerVersion || "",
        entityCount: resolved.bundle.entities.length,
        dimensionCount: resolved.bundle.dimensions.length,
        metricCount: resolved.bundle.metrics.length,
        runtimeReadyMetricCount: readyMetricIds.length,
        approvedPlannedMetricCount: Array.isArray(report.approvedPlannedMetricIds)
          ? report.approvedPlannedMetricIds.length
          : 0,
        adapterIds,
      },
    };
  } catch (error) {
    return layerError("UNIFIED_SEMANTIC_KERNEL_UNAVAILABLE", error?.message || String(error));
  }
}

function loadHarnessLayer() {
  try {
    const registry = createMainAgentToolRegistry(MAIN_AGENT_TOOLS);
    const registeredToolNames = new Set(MAIN_AGENT_TOOLS.map((tool) => tool.function.name));
    const semanticToolsPresent = UNIFIED_SEMANTIC_TOOL_NAMES
      .filter((name) => registeredToolNames.has(name));
    const intentsCoveringSemanticTools = Object.entries(MAIN_AGENT_INTENT_PROFILES)
      .filter(([, profile]) => Array.isArray(profile?.toolNames)
        && UNIFIED_SEMANTIC_TOOL_NAMES.some((name) => profile.toolNames.includes(name)))
      .map(([intent]) => intent);
    return {
      ok: true,
      registry,
      summary: {
        layer: "codex.harness",
        orchestratorEntry: "runMainAgentToolTurn",
        runtime: "langgraph",
        intentCount: Object.keys(MAIN_AGENT_INTENT_PROFILES).length,
        toolCount: registeredToolNames.size,
        semanticToolsPresent,
        intentsCoveringSemanticTools,
      },
    };
  } catch (error) {
    return layerError("UNIFIED_HARNESS_UNAVAILABLE", error?.message || String(error));
  }
}

async function loadDataPlaneLayer({ analyticsApiBase, actor }) {
  const summary = {
    layer: "data-plane",
    semanticEndpointPath: SEMANTIC_QUERY_ENDPOINT_PATH,
    analyticsApiBase: analyticsApiBase || resolveAnalyticsApiBase(),
    actorConfigured: Boolean(actor),
    pythonDataPlane: "backend/analytics/semantic_query.py (FastAPI)",
  };
  return { ok: true, summary };
}

async function loadPublishedCapabilities({ root, expectedFingerprint }) {
  const capabilitiesPath = path.join(root, "ontology/generated/runtime-capabilities.json");
  let published;
  try {
    published = JSON.parse(await readFile(capabilitiesPath, "utf8"));
  } catch (error) {
    return layerError("UNIFIED_RUNTIME_CAPABILITIES_UNAVAILABLE", error?.message || String(error));
  }
  if (published.ontologyFingerprint !== expectedFingerprint) {
    return layerError(
      "UNIFIED_RUNTIME_CAPABILITIES_FINGERPRINT_MISMATCH",
      `published=${published.ontologyFingerprint} kernel=${expectedFingerprint}`,
    );
  }
  return { ok: true, published };
}

function validateContracts({ harness, kernel, capabilities }) {
  const contracts = [];

  contracts.push({
    id: "HARNESS_TOOL_SOURCE_OF_TRUTH",
    ok: harness.ok
      && UNIFIED_SEMANTIC_TOOL_NAMES.every((name) =>
        harness.summary.semanticToolsPresent.includes(name)),
    detail: `semantic tools registered: ${harness.ok ? harness.summary.semanticToolsPresent.join(", ") : "n/a"}`,
  });

  contracts.push({
    id: "HARNESS_INTENT_WIRING",
    ok: harness.ok && harness.summary.intentsCoveringSemanticTools.length > 0,
    detail: harness.ok
      ? `intents with semantic tools: ${harness.summary.intentsCoveringSemanticTools.join(", ")}`
      : "harness unavailable",
  });

  contracts.push({
    id: "SEMANTIC_KERNEL_FAIL_CLOSED",
    ok: kernel.ok,
    detail: kernel.ok
      ? `ontology ${kernel.summary.ontologyVersion} fingerprint ${kernel.summary.fingerprint.slice(0, 12)}…`
      : `${kernel.code}: ${kernel.detail}`,
  });

  contracts.push({
    id: "RUNTIME_PUBLICATION_CONSISTENT",
    ok: capabilities.ok
      && kernel.ok
      && Array.isArray(capabilities.published?.runtimeReadyMetricIds)
      && capabilities.published.runtimeReadyMetricIds.length > 0,
    detail: capabilities.ok
      ? `published ready metrics: ${(capabilities.published.runtimeReadyMetricIds || []).length}`
      : `${capabilities.code}: ${capabilities.detail}`,
  });

  if (kernel.ok) {
    const approvedIds = new Set(kernel.registry.bundle.metrics
      .filter((metric) => metric.governance?.status === "approved")
      .map((metric) => metric.id));
    const unapprovedReady = kernel.report.runtimeReadyMetricIds
      .filter((metricId) => !approvedIds.has(metricId));
    contracts.push({
      id: "READY_METRICS_GOVERNED",
      ok: unapprovedReady.length === 0,
      detail: unapprovedReady.length === 0
        ? "all runtime-ready metrics are governance-approved"
        : `not approved: ${unapprovedReady.join(", ")}`,
    });
  }

  contracts.push({
    id: "ORCHESTRATOR_INJECTABLE_BOUNDARY",
    ok: typeof runMainAgentToolTurn === "function",
    detail: "runMainAgentToolTurn accepts injectable requestToolCompletion/executeToolCall",
  });

  return contracts;
}

export async function createUnifiedDataAgentSystem({
  root = DEFAULT_ROOT,
  registry,
  analyticsApiBase,
  analyticsFetch,
  actor,
  actorCapabilitySecret,
  actorCapabilityNow,
  actorCapabilityNonce,
  actorCapabilityEnv,
  now = () => new Date().toISOString(),
} = {}) {
  const harness = loadHarnessLayer();
  const kernel = loadSemanticKernelLayer({ root, registry });
  const capabilities = kernel.ok
    ? await loadPublishedCapabilities({ root, expectedFingerprint: kernel.summary.fingerprint })
    : layerError("UNIFIED_RUNTIME_CAPABILITIES_SKIPPED", "semantic kernel unavailable");
  const dataPlane = await loadDataPlaneLayer({ analyticsApiBase, actor });
  const contracts = validateContracts({ harness, kernel, capabilities });

  function snapshot() {
    return {
      system: {
        name: UNIFIED_SYSTEM_NAME,
        version: UNIFIED_SYSTEM_VERSION,
        generatedAt: now(),
        integration: "codex-harness × pi-semantic-kernel × data-plane",
      },
      layers: {
        harness: harness.ok ? harness.summary : { layer: "codex.harness", ...harness },
        semanticKernel: kernel.ok ? kernel.summary : { layer: "pi.semantic-kernel", ...kernel },
        dataPlane: dataPlane.summary,
      },
      contracts,
      ok: harness.ok && kernel.ok && capabilities.ok && contracts.every((item) => item.ok),
    };
  }

  function validateIntegrationContracts() {
    return {
      ok: contracts.every((item) => item.ok),
      contracts,
    };
  }

  function bindToolExecutor() {
    return (toolCall, deps = {}) => executeMainAgentToolCall(toolCall, {
      analyticsFetch,
      analyticsApiBase: analyticsApiBase || resolveAnalyticsApiBase(),
      ...(actor ? { actor } : {}),
      ...(actorCapabilitySecret ? { actorCapabilitySecret } : {}),
      ...(actorCapabilityNow !== undefined ? { actorCapabilityNow } : {}),
      ...(actorCapabilityNonce ? { actorCapabilityNonce } : {}),
      ...(actorCapabilityEnv ? { actorCapabilityEnv } : {}),
      ...deps,
    });
  }

  async function runDataAgentTurn(turnOptions = {}) {
    const defaults = {};
    if (!turnOptions.executeToolCall) {
      defaults.executeToolCall = bindToolExecutor();
    }
    const turn = await runMainAgentToolTurn({
      toolDependencies: actor ? { actor } : {},
      ...defaults,
      ...turnOptions,
    });
    return {
      ...turn,
      system: {
        name: UNIFIED_SYSTEM_NAME,
        version: UNIFIED_SYSTEM_VERSION,
        ontologyFingerprint: kernel.ok ? kernel.summary.fingerprint : null,
      },
    };
  }

  return Object.freeze({
    snapshot,
    validateIntegrationContracts,
    runDataAgentTurn,
    layers: Object.freeze({
      harness: harness.ok ? harness.registry : null,
      semanticKernel: kernel.ok ? kernel.registry : null,
    }),
  });
}
