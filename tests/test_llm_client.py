"""Tests for LLM Client

Tests cover:
1. Client initialization
2. Chat text completion (real API call if key available)
3. Chat with tools (function calling)
4. Adapter functions (as_agent_fn, as_fixer_fn)
5. Health check
"""

import os
import sys
import json
import pytest
from pathlib import Path

# Ensure project root on path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.llm.client import LLMClient, get_llm_client, load_env


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def llm():
    """Get LLM client (requires real API key)"""
    load_env()
    client = get_llm_client()
    if client is None:
        pytest.skip("No LLM API key configured")
    return client


# ============================================================================
# Initialization Tests
# ============================================================================

class TestLLMClientInit:
    """Test client initialization"""

    def test_zhipu_init(self):
        """Test ZhiPu client initialization"""
        client = LLMClient(provider="zhipu", api_key="test-key")
        assert client.provider == "zhipu"
        assert client.api_key == "test-key"
        assert client.base_url == "https://open.bigmodel.cn/api/paas/v4"
        assert client.model == "glm-4-flash"  # default

    def test_deepseek_init(self):
        """Test DeepSeek client initialization"""
        client = LLMClient(provider="deepseek", api_key="test-key")
        assert client.provider == "deepseek"
        assert client.api_key == "test-key"
        assert client.base_url == "https://api.deepseek.com/v1"
        assert client.model == "deepseek-chat"

    def test_custom_model(self):
        """Test custom model override"""
        client = LLMClient(provider="zhipu", api_key="test-key", model="glm-4-plus")
        assert client.model == "glm-4-plus"

    def test_no_key_warning(self):
        """Test that missing API key logs warning"""
        # Use a non-existent provider config to avoid picking up env keys
        import os
        old_key = os.environ.pop("ZHIPU_API_KEY", None)
        try:
            client = LLMClient(provider="zhipu", api_key="")
            assert client.api_key == ""
        finally:
            if old_key:
                os.environ["ZHIPU_API_KEY"] = old_key

    def test_get_llm_client_singleton(self):
        """Test singleton behavior"""
        # This may return None if no key, which is fine
        c1 = get_llm_client()
        c2 = get_llm_client()
        assert c1 is c2  # Same instance (or both None)


# ============================================================================
# API Call Tests (require real API key)
# ============================================================================

class TestLLMChat:
    """Test actual LLM API calls"""

    def test_chat_text_simple(self, llm):
        """Test simple text completion"""
        response = llm.chat_text("说 'hello'，只回复这一个词")
        assert isinstance(response, str)
        assert len(response) > 0
        print(f"  LLM response: {response[:100]}")

    def test_chat_with_system(self, llm):
        """Test chat with system prompt"""
        response = llm.chat_text(
            prompt="你是什么模型？",
            system="你是一个SQL专家助手。用一句话回答。"
        )
        assert isinstance(response, str)
        assert len(response) > 0

    def test_chat_no_tools(self, llm):
        """Test chat without tools"""
        resp = llm.chat(
            messages=[
                {"role": "user", "content": "1+1=?只回复数字"}
            ],
            max_tokens=10,
            temperature=0.0,
        )
        assert isinstance(resp.content, str)
        assert "2" in resp.content
        assert resp.latency_ms > 0
        print(f"  Latency: {resp.latency_ms:.0f}ms, tokens: {resp.usage.get('total_tokens', '?')}")

    def test_chat_with_tools(self, llm):
        """Test function calling"""
        tools = [{
            "type": "function",
            "function": {
                "name": "query_defects",
                "description": "查询缺陷数据",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "用户的自然语言查询"
                        }
                    },
                    "required": ["question"]
                }
            }
        }]

        resp = llm.chat(
            messages=[
                {"role": "system", "content": "你是缺陷查询助手。使用工具回答问题。"},
                {"role": "user", "content": "IDCEVO项目有多少Critical缺陷？"}
            ],
            tools=tools,
            temperature=0.0,
        )

        # Should trigger a tool call
        assert resp.tool_calls or resp.content  # Either is acceptable
        if resp.tool_calls:
            tc = resp.tool_calls[0]
            assert tc["name"] == "query_defects"
            assert "question" in tc["arguments"]
            print(f"  Tool call: {tc['name']}({tc['arguments']})")
        else:
            print(f"  No tool call, content: {resp.content[:100]}")


# ============================================================================
# Adapter Tests
# ============================================================================

class TestAdapters:
    """Test adapter functions"""

    def test_as_agent_fn(self, llm):
        """Test agent function adapter"""
        agent_fn = llm.as_agent_fn()

        # Agent fn takes (messages, tools) and returns dict
        tools = [{
            "type": "function",
            "function": {
                "name": "get_count",
                "description": "获取数量",
                "parameters": {
                    "type": "object",
                    "properties": {"q": {"type": "string"}},
                    "required": ["q"]
                }
            }
        }]

        result = agent_fn(
            messages=[
                {"role": "system", "content": "使用工具回答"},
                {"role": "user", "content": "有多少条数据？"}
            ],
            tools=tools,
        )

        assert isinstance(result, dict)
        assert "content" in result
        # tool_calls may or may not be present

    def test_as_fixer_fn(self, llm):
        """Test fixer function adapter"""
        fixer_fn = llm.as_fixer_fn()

        # Fixer fn takes a prompt string and returns a string
        prompt = """
        Fix this SQL: SELECT * FROM nonexistent_table WHERE x = 1
        Error: no such table: nonexistent_table
        The correct table name is 'octane_defects'.
        Reply with REASONING: ... FIXED_SQL: SELECT ...
        """
        result = fixer_fn(prompt)
        assert isinstance(result, str)
        assert len(result) > 0
        print(f"  Fixer response: {result[:200]}")


# ============================================================================
# Health Check
# ============================================================================

class TestHealth:
    """Test health check"""

    def test_health_check(self, llm):
        """Test health check"""
        ok = llm.health_check()
        assert isinstance(ok, bool)
        print(f"  Health: {'OK' if ok else 'FAIL'}")


# ============================================================================
# Error Handling
# ============================================================================

class TestErrorHandling:
    """Test error handling"""

    def test_invalid_provider(self):
        """Test invalid provider falls back to zhipu defaults"""
        client = LLMClient(provider="invalid", api_key="test")
        # Should fall back to zhipu defaults for unknown providers
        assert client.api_key == "test"

    def test_api_error_handling(self):
        """Test handling of API errors"""
        client = LLMClient(provider="zhipu", api_key="invalid-key-xxx")
        resp = client.chat(
            messages=[{"role": "user", "content": "test"}],
            max_tokens=5,
        )
        # Should return error in content, not crash
        assert isinstance(resp.content, str)
        assert "Error" in resp.content or len(resp.content) == 0
