import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AgentRunTimeline from "@/components/dashboard/chat/AgentRunTimeline";
import MessageRenderer from "@/components/dashboard/chat/MessageRenderer";
import type { PublicAgentEvent } from "@/lib/agentEventStream";

const baseEvent = {
  schemaVersion: "1.0",
  eventId: "evt-1",
  runId: "run-1",
  threadId: "thread-1",
  stateVersion: 1,
  sequence: 1,
  timestamp: "2026-07-14T00:00:00.000Z",
};

describe("AgentRunTimeline", () => {
  it("renders public lifecycle fields without private reasoning or raw answer deltas", () => {
    render(
      <AgentRunTimeline
        events={[
          { ...baseEvent, type: "run.started", payload: { threadVersion: 1, runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash" } },
          { ...baseEvent, eventId: "evt-model", sequence: 2, type: "model.completed", payload: { modelId: "deepseek-v4-flash", purpose: "planning", finishReason: "stop", inputTokens: 10, outputTokens: 5 } },
          { ...baseEvent, eventId: "evt-2", sequence: 2, type: "ontology.resolved", payload: { semanticFrameRef: { ontologyVersion: "legacy-provisional", schemaFingerprint: "legacy-v0", requestAnchorAt: "2026-07-14T00:00:00.000Z" }, mode: "legacy_provisional", ambiguityCodes: [] } },
          { ...baseEvent, eventId: "evt-3", sequence: 3, type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: { filters: { years: 2026 }, credential: "secret" } } },
          { ...baseEvent, eventId: "evt-4", sequence: 4, type: "evidence.added", payload: { evidenceIds: ["ev-1"], groundingStatus: "legacy_equivalence" } },
          { ...baseEvent, eventId: "evt-5", sequence: 5, type: "answer.delta", payload: { answerId: "answer-1", contentHash: "hash", offset: 0, text: "final answer" } },
          { ...baseEvent, eventId: "evt-6", sequence: 6, type: "answer.completed", payload: { answerId: "answer-1", contentHash: "hash", acceptedClaimIds: ["c1"], citations: [{ citationId: "cite-1", label: "source", claimIds: ["c1"], evidenceIds: ["ev-1"] }], assumptions: [], limitations: [], groundingStatus: "legacy_equivalence", sourceRevisionSet: {} } },
          { ...baseEvent, eventId: "evt-7", sequence: 7, type: "run.completed", payload: { answerId: "answer-1", threadVersion: 2, durationMs: 12 } },
        ] as PublicAgentEvent[]}
      />,
    );

    expect(screen.getByText(/langgraph/)).toBeInTheDocument();
    expect(screen.getByText(/Planning model/)).toBeInTheDocument();
    expect(screen.getByText(/legacy_provisional/)).toBeInTheDocument();
    expect(screen.getByText(/query_dashboard_summary/)).toBeInTheDocument();
    expect(screen.getAllByText(/legacy_equivalence/)).toHaveLength(2);
    expect(screen.getByText("Answer grounded")).toBeInTheDocument();
    expect(screen.getByText(/1 citations/)).toBeInTheDocument();
    expect(screen.queryByText(/final answer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/reasoning|chain/i)).not.toBeInTheDocument();
  });

  it("hides private thinking segments from assistant messages", () => {
    render(<MessageRenderer content={'<think>private</think>\n\nVisible **answer**'} streaming={false} />);

    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(screen.getByText(/Visible/)).toBeInTheDocument();
  });
});
