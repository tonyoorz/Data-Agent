"""Unified LLM Client

Supports ZhiPu GLM and DeepSeek via their OpenAI-compatible APIs.
Both providers support function calling, streaming, and system prompts.

Provider endpoints:
- ZhiPu GLM: https://open.bigmodel.cn/api/paas/v4/chat/completions
- DeepSeek:  https://api.deepseek.com/v1/chat/completions

Cost-effective defaults:
- ZhiPu: glm-4-flash (free tier, fast, good enough for SQL generation)
- DeepSeek: deepseek-chat (very cheap, strong code/SQL capability)
"""

from __future__ import annotations

import os
import json
import time
import logging
from typing import Dict, List, Optional, Callable, Any
from pathlib import Path
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)


# ============================================================================
# Config
# ============================================================================

def load_env():
    """Load .env file into os.environ (lightweight, no python-dotenv dependency)"""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            # Don't override existing env vars
            if key not in os.environ:
                os.environ[key] = value


# Load on import
load_env()


PROVIDER_CONFIG = {
    "zhipu": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "default_model": "glm-4-flash",
        "api_key_env": "ZHIPU_API_KEY",
        "max_tokens": 4096,
        "temperature": 0.1,  # Low temperature for SQL generation
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "default_model": "deepseek-chat",
        "api_key_env": "DEEPSEEK_API_KEY",
        "max_tokens": 4096,
        "temperature": 0.1,
    },
}


@dataclass
class LLMMessage:
    """Unified message format"""
    role: str
    content: str
    tool_calls: Optional[List[Dict]] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None

    def to_dict(self) -> Dict:
        d = {"role": self.role, "content": self.content}
        if self.tool_calls:
            d["tool_calls"] = self.tool_calls
        if self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
        if self.name:
            d["name"] = self.name
        return d


@dataclass
class LLMResponse:
    """Unified LLM response"""
    content: str = ""
    tool_calls: List[Dict] = field(default_factory=list)
    raw: Optional[Dict] = None
    usage: Dict = field(default_factory=dict)
    latency_ms: float = 0.0

    def to_agent_format(self) -> Dict:
        """Convert to format expected by ReActAgent._process_with_llm"""
        return {
            "content": self.content,
            "tool_calls": self.tool_calls if self.tool_calls else None,
        }


# ============================================================================
# LLM Client
# ============================================================================

class LLMClient:
    """
    Unified LLM client.

    Uses httpx for async-friendly HTTP calls.
    Supports function calling in OpenAI format.

    Example:
        client = LLMClient(provider="zhipu")

        # Chat with tools
        resp = client.chat(
            messages=[{"role": "user", "content": "IDCEVO有多少Critical缺陷?"}],
            tools=my_tool_schemas
        )
        if resp.tool_calls:
            for call in resp.tool_calls:
                print(call["name"], call["arguments"])
        else:
            print(resp.content)
    """

    def __init__(
        self,
        provider: str = "zhipu",
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.provider = provider
        config = PROVIDER_CONFIG.get(provider, PROVIDER_CONFIG["zhipu"])

        self.api_key = api_key or os.environ.get(config["api_key_env"], "")
        self.model = model or os.environ.get(f"{provider.upper()}_MODEL", config["default_model"])
        self.base_url = base_url or config["base_url"]
        self.max_tokens = config["max_tokens"]
        self.temperature = config["temperature"]
        self.timeout = timeout

        if not self.api_key:
            logger.warning(f"No API key for provider '{provider}'. LLM calls will fail.")

        logger.info(f"LLMClient initialized: provider={provider}, model={self.model}")

    # ==================== Core Chat ====================

    def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        stop: Optional[List[str]] = None,
    ) -> LLMResponse:
        """
        Chat completion with optional function calling.

        Args:
            messages: OpenAI-format messages
            tools: OpenAI-format tool definitions [{"type": "function", "function": {...}}]
            temperature: Override default temperature
            max_tokens: Override default max_tokens
            stop: Stop sequences

        Returns:
            LLMResponse with content and/or tool_calls
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature if temperature is not None else self.temperature,
            "max_tokens": max_tokens or self.max_tokens,
        }

        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        if stop:
            payload["stop"] = stop

        url = f"{self.base_url}/chat/completions"
        t0 = time.time()

        try:
            with httpx.Client(timeout=self.timeout) as http_client:
                resp = http_client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

            latency = (time.time() - t0) * 1000

            # Parse response (OpenAI format, both providers compatible)
            choice = data.get("choices", [{}])[0]
            message = choice.get("message", {})

            content = message.get("content", "") or ""
            raw_tool_calls = message.get("tool_calls", [])

            # Normalize tool_calls to our format
            tool_calls = []
            for tc in raw_tool_calls:
                fn = tc.get("function", {})
                args_str = fn.get("arguments", "{}")
                try:
                    args = json.loads(args_str) if isinstance(args_str, str) else args_str
                except json.JSONDecodeError:
                    args = {"_raw": args_str}

                tool_calls.append({
                    "id": tc.get("id", ""),
                    "name": fn.get("name", ""),
                    "arguments": args,
                    "thought": content,  # LLM reasoning before the call
                })

            usage = data.get("usage", {})

            logger.debug(
                f"LLM chat: {latency:.0f}ms, "
                f"tokens={usage.get('total_tokens', '?')}, "
                f"tool_calls={len(tool_calls)}"
            )

            return LLMResponse(
                content=content,
                tool_calls=tool_calls,
                raw=data,
                usage=usage,
                latency_ms=latency,
            )

        except httpx.HTTPStatusError as e:
            logger.error(f"LLM API error {e.response.status_code}: {e.response.text[:500]}")
            return LLMResponse(content=f"[LLM Error: {e.response.status_code}]")
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            return LLMResponse(content=f"[LLM Error: {str(e)}]")

    def chat_text(
        self,
        prompt: str,
        system: str = "",
        temperature: float = 0.1,
    ) -> str:
        """
        Simple text completion. Returns just the text.

        Used by QueryFixer and other components that just need text in/out.

        Args:
            prompt: User prompt
            system: Optional system prompt
            temperature: Sampling temperature

        Returns:
            LLM response text
        """
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        resp = self.chat(messages, temperature=temperature, tools=None)
        return resp.content

    # ==================== Adapters ====================

    def as_agent_fn(self) -> Callable:
        """
        Return a callable compatible with ReActAgent.llm_call_fn.

        Signature: fn(messages: List[Dict], tools: List[Dict]) -> Dict
        Returns: {"content": str, "tool_calls": [{"name", "arguments", "thought"}] | None}
        """
        def agent_fn(messages: List[Dict], tools: List[Dict]) -> Dict:
            # Convert tool schemas to OpenAI format if needed
            openai_tools = []
            for t in tools:
                if t.get("type") == "function":
                    openai_tools.append(t)
                else:
                    # Our schema format: {"name": ..., "description": ..., "parameters": {...}}
                    openai_tools.append({
                        "type": "function",
                        "function": {
                            "name": t.get("name", ""),
                            "description": t.get("description", ""),
                            "parameters": t.get("parameters", {"type": "object", "properties": {}}),
                        }
                    })

            resp = self.chat(messages=messages, tools=openai_tools if openai_tools else None)
            return resp.to_agent_format()

        return agent_fn

    def as_fixer_fn(self) -> Callable:
        """
        Return a callable compatible with QueryFixer.llm_call_fn.

        Signature: fn(prompt: str) -> str
        """
        def fixer_fn(prompt: str) -> str:
            return self.chat_text(prompt, temperature=0.0)

        return fixer_fn

    def as_generator_fn(self) -> Callable:
        """
        Return a callable for NL2SQLEngine.llm_call_fn.

        Used for LLM-enhanced SQL generation.
        Signature: fn(prompt: str) -> str
        """
        return self.as_fixer_fn()

    # ==================== Health ====================

    def health_check(self) -> bool:
        """Quick health check - send a tiny prompt"""
        try:
            resp = self.chat(
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=5,
                temperature=0.0,
            )
            return bool(resp.content)
        except Exception:
            return False


# ============================================================================
# Singleton
# ============================================================================

_client: Optional[LLMClient] = None


def get_llm_client(
    provider: Optional[str] = None,
    **kwargs,
) -> Optional[LLMClient]:
    """
    Get or create the singleton LLM client.

    Provider is determined by:
    1. Explicit argument
    2. AGENT_LLM_PROVIDER env var
    3. Default: "zhipu"

    Returns None if provider is "none" or no API key available.
    """
    global _client
    if _client is not None:
        return _client

    provider = provider or os.environ.get("AGENT_LLM_PROVIDER", "zhipu")

    if provider == "none":
        logger.info("LLM disabled (AGENT_LLM_PROVIDER=none)")
        return None

    try:
        _client = LLMClient(provider=provider, **kwargs)
        if not _client.api_key:
            logger.warning(f"No API key for provider '{provider}', LLM disabled")
            return None
        logger.info(f"LLM client ready: {_client.provider}/{_client.model}")
    except Exception as e:
        logger.error(f"Failed to init LLM client: {e}")
        return None

    return _client
