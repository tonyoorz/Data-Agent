import { describe, expect, it } from "vitest";

import {
  buildToolCallingProbeRequest,
  classifyToolCallingProbePayload,
} from "../../../server/chatToolProbe.mjs";

describe("chat tool calling probe", () => {
  it("builds a forced function-calling probe request", () => {
    const request = buildToolCallingProbeRequest({
      model: "deepseek-v4-flash",
      env: {
        DUPSEARCH_CHAT_ACCESS_CODE: "test-access-code",
      },
    });

    expect(request.body.messages).toEqual([
      {
        role: "user",
        content: "Call get_probe_status with reason=tool-capability-check.",
      },
    ]);
    expect(request.body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "get_probe_status" }),
      }),
    ]);
    expect(request.body.tool_choice).toEqual({
      type: "function",
      function: { name: "get_probe_status" },
    });
  });

  it("classifies tool_calls responses as supported", () => {
    const result = classifyToolCallingProbePayload({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_probe_status", arguments: '{"reason":"tool-capability-check"}' },
              },
            ],
          },
        },
      ],
    });

    expect(result.supported).toBe(true);
    expect(result.toolCallCount).toBe(1);
    expect(result.firstToolName).toBe("get_probe_status");
  });

  it("classifies plain text responses as unsupported", () => {
    const result = classifyToolCallingProbePayload({
      choices: [{ message: { content: "I cannot call tools here." } }],
    });

    expect(result.supported).toBe(false);
    expect(result.toolCallCount).toBe(0);
    expect(result.contentPreview).toBe("I cannot call tools here.");
  });
});