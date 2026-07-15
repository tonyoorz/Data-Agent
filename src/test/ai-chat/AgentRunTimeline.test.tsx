import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AgentRunTimeline from "@/components/dashboard/chat/AgentRunTimeline";
import MessageRenderer from "@/components/dashboard/chat/MessageRenderer";

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
          { ...baseEvent, eventId: "evt-2", sequence: 2, type: "ontology.resolved", payload: { semanticFrameRef: { ontologyVersion: "legacy-provisional", schemaFingerprint: "legacy-v0", requestAnchorAt: "2026-07-14T00:00:00.000Z" }, mode: "legacy_provisional", ambiguityCodes: [] } },
          { ...baseEvent, eventId: "evt-3", sequence: 3, type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: { filters: { years: 2026 }, credential: "secret" } } },
          { ...baseEvent, eventId: "evt-4", sequence: 4, type: "evidence.added", payload: { evidenceIds: ["ev-1"], groundingStatus: "legacy_equivalence" } },
          { ...baseEvent, eventId: "evt-5", sequence: 5, type: "answer.delta", payload: { answerId: "answer-1", contentHash: "hash", offset: 0, text: "final answer" } },
          { ...baseEvent, eventId: "evt-6", sequence: 6, type: "run.completed", payload: { answerId: "answer-1", threadVersion: 2, durationMs: 12 } },
        ] as any}
      />,
    );

    expect(screen.getByText(/langgraph/)).toBeInTheDocument();
    expect(screen.getByText(/legacy_provisional/)).toBeInTheDocument();
    expect(screen.getByText(/query_dashboard_summary/)).toBeInTheDocument();
    expect(screen.getByText(/legacy_equivalence/)).toBeInTheDocument();
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