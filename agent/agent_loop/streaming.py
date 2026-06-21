"""SSE Event Stream - Stream agent steps as Server-Sent Events

Converts AgentStep events into SSE-formatted messages
compatible with the existing Data-Agent Node gateway.

Event types:
- thought: Agent reasoning step
- action: Tool call
- observation: Tool result
- final: Final answer
- error: Error occurred
"""

import json
import time
from typing import Generator, Dict, Any

from agent.agent_loop.loop import ReActAgent, AgentStep, StepType


class SSEEventStream:
    """
    Convert agent execution into SSE events.

    Usage in FastAPI:
        @app.get("/api/agent/stream")
        def stream_agent(question: str):
            stream = SSEEventStream(agent)
            return StreamingResponse(
                stream.process(question),
                media_type="text/event-stream"
            )
    """

    # Event type mapping
    EVENT_TYPES = {
        StepType.THOUGHT: "thought",
        StepType.ACTION: "action",
        StepType.OBSERVATION: "observation",
        StepType.FINAL: "final",
        StepType.ERROR: "error",
    }

    def __init__(self, agent: ReActAgent):
        self.agent = agent

    def process(self, question: str) -> Generator[str, None, None]:
        """
        Process question and yield SSE-formatted events.

        Yields strings in SSE format: "data: {json}\\n\\n"
        """
        # Send start event
        yield self._format_event("start", {
            "question": question,
            "timestamp": time.time()
        })

        # Process and stream steps
        for step in self.agent.process_stream(question):
            event_type = self.EVENT_TYPES.get(step.step_type, "step")
            data = self._step_to_dict(step)
            yield self._format_event(event_type, data)

        # Send end event
        yield self._format_event("done", {
            "timestamp": time.time()
        })

    def _step_to_dict(self, step: AgentStep) -> Dict[str, Any]:
        """Convert AgentStep to dict for SSE"""
        data = {
            "content": step.content,
            "timestamp": step.timestamp,
        }

        if step.tool_name:
            data["tool"] = step.tool_name

        if step.tool_input:
            data["input"] = step.tool_input

        if step.tool_output:
            data["output"] = {
                "success": step.tool_output.success,
                "summary": step.tool_output.summary,
            }
            # Include data if reasonable size
            if step.tool_output.data:
                if isinstance(step.tool_output.data, list):
                    data["rows"] = len(step.tool_output.data)
                    data["preview"] = step.tool_output.data[:5]
                elif isinstance(step.tool_output.data, dict):
                    data["preview"] = {k: v for k, v in
                                      list(step.tool_output.data.items())[:10]}

        return data

    def _format_event(self, event_type: str, data: Dict) -> str:
        """Format as SSE event"""
        payload = json.dumps(data, ensure_ascii=False, default=str)
        return f"event: {event_type}\ndata: {payload}\n\n"

    @staticmethod
    def parse_event(sse_string: str) -> Dict[str, Any]:
        """Parse an SSE event string back to dict (for client-side debugging)"""
        lines = sse_string.strip().split("\n")
        event_type = ""
        data = ""
        for line in lines:
            if line.startswith("event: "):
                event_type = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        return {
            "event": event_type,
            "data": json.loads(data) if data else {}
        }
