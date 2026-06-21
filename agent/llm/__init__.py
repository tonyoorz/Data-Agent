"""LLM Client Module

Unified LLM client supporting ZhiPu GLM and DeepSeek via OpenAI-compatible API.

Usage:
    from agent.llm import get_llm_client

    client = get_llm_client()

    # Simple text completion (for QueryFixer)
    text = client.chat_text("Translate: hello world")

    # Chat with function calling (for ReActAgent)
    result = client.chat(
        messages=[{"role": "user", "content": "How many defects?"}],
        tools=[{"type": "function", "function": {...}}]
    )
    # result = {"content": "...", "tool_calls": [{"name": "...", "arguments": {...}}]}

    # Get adapted callables for existing interfaces
    agent_fn = client.as_agent_fn()    # (messages, tool_schemas) -> dict
    fixer_fn = client.as_fixer_fn()    # (prompt: str) -> str
"""

from agent.llm.client import LLMClient, get_llm_client

__all__ = ["LLMClient", "get_llm_client"]
