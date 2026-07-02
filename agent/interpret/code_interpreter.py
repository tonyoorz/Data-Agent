"""Python Code Interpreter — Safe sandboxed execution for data analysis

When SQL can't express complex logic (statistical tests, custom
transformations, anomaly detection), the LLM generates Python code
that operates on query results.

Design:
1. CodeGen: LLM generates Python code from NL + data context
2. Sandbox: Restricted exec with timeout, no network, no file write
3. Formatter: Convert execution result to natural language

Safety (layered defense, trusted single-user threat model):
- Layer 1: AST static analysis — reject disallowed imports, dunder
  introspection (``__class__``/``__subclasses__``/``__mro__``/...) and
  dangerous builtin names. Replaces the old substring denylist, which
  was trivially bypassable.
- Layer 2: restricted ``__builtins__`` at runtime — dangerous builtins
  (``open``/``eval``/``exec``/``getattr``/...) are removed and
  ``__import__`` is replaced with an allowlist-guarded import, so even
  an AST miss can't escalate. User code runs in an isolated namespace
  that only exposes ``data``.
- Layer 3: OS resource limits via ``resource.setrlimit`` (CPU seconds,
  file-write size, optional address-space cap) applied in the child
  process before exec.
- Layer 4: minimal subprocess environment (scrubbed env, ``-E``,
  temp ``cwd``).

Usage:
    from agent.interpret.code_interpreter import CodeInterpreter

    ci = CodeInterpreter(llm_call_fn=my_fn, db_path='/path/to/db')
    result = ci.execute(
        question='哪个ECU的缺陷增长率最高',
        data=[{'ecu': 'IHU', 'count': 100}, ...],
    )
    # → {'success': True, 'output': 'IHU has highest growth...', 'code': '...'}
"""

from __future__ import annotations

import ast
import json
import logging
import os
import resource
import subprocess
import sys
import tempfile
import time
import textwrap
from pathlib import Path
from typing import List, Dict, Optional, Any, Callable

logger = logging.getLogger(__name__)


# ============================================================================
# Code Generation Prompt
# ============================================================================

CODE_GEN_PROMPT = """你是一个 Python 数据分析代码生成器。

用户问题：{question}

查询结果数据（JSON 格式）：
{data}

请生成 Python 代码来分析上述数据，回答用户问题。

可用库：pandas, numpy, math, re, json, statistics, time
限制：
- 不要 import 其它库
- 不要读写文件
- 不要访问网络
- 代码必须在 3 秒内完成

数据已加载为变量 `data`（list of dict）。
请将最终分析结果赋值给变量 `result`（字符串或数字）。

只输出 Python 代码，不要解释。
"""


# ============================================================================
# Safety Visitor (Layer 1: AST static analysis)
# ============================================================================

class _SafetyVisitor(ast.NodeVisitor):
    """Walks user code once, recording the first policy violation."""

    def __init__(self, safe_imports, dunder_block, dangerous_names):
        self.safe_imports = safe_imports
        self.dunder_block = dunder_block
        self.dangerous_names = dangerous_names
        self.reason: Optional[str] = None

    def _flag(self, reason: str) -> None:
        if self.reason is None:
            self.reason = reason

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root = alias.name.split('.')[0]
            if root not in self.safe_imports:
                self._flag(f"不支持的库: {root}")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level and node.level > 0:
            self._flag("禁止相对导入")
        else:
            root = (node.module or "").split('.')[0]
            if root not in self.safe_imports:
                self._flag(f"不支持的库: {root}")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in self.dunder_block:
            self._flag(f"禁止访问: {node.attr}")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in self.dangerous_names:
            self._flag(f"禁止使用: {node.id}")
        self.generic_visit(node)


# ============================================================================
# Code Interpreter
# ============================================================================

class CodeInterpreter:
    """
    Generate and execute Python code for complex data analysis.

    Flow:
    1. LLM generates Python code from question + data
    2. Code is executed in a subprocess sandbox
    3. Result is extracted and returned

    When LLM is not available, falls back to basic statistical functions.
    """

    # Safe imports allowed in generated code
    SAFE_IMPORTS = {
        "pandas", "numpy", "math", "re", "json",
        "statistics", "collections", "itertools", "time",
    }

    # Dunder attributes that enable the standard introspection escape chain.
    # Blocking these at the AST level cuts ().__class__.__mro__...__subclasses__()
    # and friends.
    _DUNDER_BLOCK = frozenset({
        "__import__", "__builtins__", "__class__", "__subclasses__",
        "__bases__", "__base__", "__mro__", "__globals__", "__locals__",
        "__code__", "__dict__", "__loader__", "__spec__", "__self__",
        "__func__", "__closure__", "__wrapped__", "__subclasshook__",
    })

    # Bare names that must never appear in user code (builtins / lookups).
    _DANGEROUS_NAMES = frozenset({
        "__import__", "eval", "exec", "compile", "open", "breakpoint",
        "getattr", "setattr", "delattr", "vars", "globals", "locals",
        "dir", "input", "memoryview", "exit", "quit", "help",
    })

    # Builtins stripped from the runtime namespace (Layer 2).
    _BLOCKED_BUILTINS = frozenset({
        "__import__", "open", "eval", "exec", "compile", "input",
        "breakpoint", "getattr", "setattr", "delattr", "vars",
        "globals", "locals", "dir", "memoryview", "exit", "quit", "help",
    })

    def __init__(
        self,
        llm_call_fn: Optional[Callable] = None,
        timeout: int = 5,
        memory_limit_mb: Optional[int] = None,
        cpu_limit: Optional[int] = None,
    ):
        self.llm_call_fn = llm_call_fn
        self.timeout = timeout
        # RLIMIT_AS is opt-in: a fixed address-space cap can collide with
        # numpy/pandas virtual-memory footprint, and is not reliably enforced
        # on all platforms (e.g. macOS overcommit). Off by default.
        self.memory_limit_mb = memory_limit_mb
        # RLIMIT_CPU is opt-in too: it sums CPU across threads, so BLAS-backed
        # numpy/pandas imports trip a tight limit. The wall-clock `timeout`
        # is the primary CPU guard.
        self.cpu_limit = cpu_limit
        # Max bytes the sandbox may write to any file. Safe to enforce by
        # default (analysis libs don't write large files).
        self.fsize_limit_bytes = 1 * 1024 * 1024  # 1 MB

    def execute(
        self,
        question: str,
        data: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Generate and execute Python code to analyze data.

        Returns:
            {
                'success': bool,
                'output': str,      # result or error
                'code': str,        # generated code
                'time_ms': float,
            }
        """
        start = time.time()

        # Generate code
        code = self._generate_code(question, data)
        if not code:
            return {
                'success': False,
                'output': '无法生成分析代码',
                'code': '',
                'time_ms': (time.time() - start) * 1000,
            }

        # Safety check
        safety = self._check_safety(code)
        if not safety['safe']:
            return {
                'success': False,
                'output': f'安全检查失败: {safety["reason"]}',
                'code': code,
                'time_ms': (time.time() - start) * 1000,
            }

        # Execute
        result = self._execute_sandbox(code, data)

        return {
            'success': result['success'],
            'output': result['output'],
            'code': code,
            'time_ms': (time.time() - start) * 1000,
            'error': result.get('error', ''),
        }

    def _generate_code(
        self,
        question: str,
        data: List[Dict[str, Any]],
    ) -> Optional[str]:
        """Generate Python code via LLM"""
        if not self.llm_call_fn:
            return self._fallback_code(question, data)

        try:
            # Truncate data for prompt
            data_sample = data[:50] if len(data) > 50 else data
            data_json = json.dumps(data_sample, ensure_ascii=False, default=str)

            prompt = CODE_GEN_PROMPT.format(
                question=question,
                data=data_json[:3000],  # Cap at 3K chars
            )

            response = self.llm_call_fn(
                messages=[
                    {"role": "system", "content": "你是 Python 代码生成助手。"},
                    {"role": "user", "content": prompt},
                ],
                tools=[],
            )

            if isinstance(response, str):
                code = response.strip()
            elif isinstance(response, dict):
                code = response.get("content", "").strip()
            else:
                code = str(response).strip()

            # Extract code from markdown fences
            if "```python" in code:
                start = code.index("```python") + 10
                end = code.index("```", start) if "```" in code[start:] else len(code)
                code = code[start:end].strip()
            elif "```" in code:
                start = code.index("```") + 3
                end = code.index("```", start) if "```" in code[start:] else len(code)
                code = code[start:end].strip()

            return code if code else None

        except Exception as e:
            logger.warning(f"Code generation failed: {e}")
            return self._fallback_code(question, data)

    def _fallback_code(
        self,
        question: str,
        data: List[Dict[str, Any]],
    ) -> Optional[str]:
        """Generate basic code without LLM (template-based)"""
        if not data:
            return None

        # Basic: just return summary statistics
        cols = list(data[0].keys()) if data else []
        code = f"""# Auto-generated analysis (no LLM)
import json
from collections import Counter

data = {json.dumps(data[:100], ensure_ascii=False, default=str)}

# Basic statistics
row_count = len(data)
columns = {cols}

# Value distribution for first column
if data:
    first_col = "{cols[0] if cols else ''}"
    values = [row.get(first_col) for row in data if row.get(first_col) is not None]
    dist = Counter(values)
    top = dist.most_common(5)
    result = f"共{{row_count}}行，{{first_col}}分布: " + ", ".join(f"{{k}}({{v}})" for k, v in top)
else:
    result = "无数据"
"""
        return code

    def _check_safety(self, code: str) -> Dict[str, Any]:
        """Layer 1: AST static analysis. Rejects disallowed imports, dunder
        introspection, and dangerous builtin names. Returns ``{safe, reason}``."""
        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return {'safe': False, 'reason': f'语法错误: {e}'}

        visitor = _SafetyVisitor(
            self.SAFE_IMPORTS, self._DUNDER_BLOCK, self._DANGEROUS_NAMES
        )
        visitor.visit(tree)
        if visitor.reason:
            return {'safe': False, 'reason': visitor.reason}
        return {'safe': True, 'reason': ''}

    def _build_script(self, code: str) -> str:
        """Build the child script: load data from stdin, install restricted
        builtins (Layer 2), then exec user code in an isolated namespace."""
        allowed = ", ".join(repr(m) for m in sorted(self.SAFE_IMPORTS))
        blocked = ", ".join(repr(m) for m in sorted(self._BLOCKED_BUILTINS))
        return textwrap.dedent(f"""\
            import json, sys, builtins as _b

            data = json.loads(sys.stdin.read())

            # --- Layer 2: restricted builtins ---
            _real_import = _b.__import__
            _ALLOWED = {{{allowed}}}
            def _safe_import(name, _globals=None, _locals=None, fromlist=(), level=0):
                if name.split('.')[0] not in _ALLOWED:
                    raise ImportError("import not allowed: " + str(name))
                return _real_import(name, _globals, _locals, fromlist, level)

            _BLOCKED = {{{blocked}}}
            SAFE_BUILTINS = {{k: v for k, v in vars(_b).items() if k not in _BLOCKED}}
            SAFE_BUILTINS["__import__"] = _safe_import
            SAFE_BUILTINS["__builtins__"] = SAFE_BUILTINS

            # User code runs here in an isolated namespace that exposes only `data`.
            USER_CODE = {code!r}
            _sentinel = object()
            _ns = {{"data": data, "__builtins__": SAFE_BUILTINS}}
            try:
                exec(compile(USER_CODE, "<sandbox>", "exec"), _ns)
                result = _ns.get("result", _sentinel)
            except Exception as _e:
                print(json.dumps({{"success": False, "result": "代码执行错误: " + str(_e)}}))
                sys.exit(0)

            if result is _sentinel:
                print(json.dumps({{"success": True, "result": "代码执行完成（无result变量）"}}))
            else:
                print(json.dumps({{"success": True, "result": str(result)}}))
        """)

    @staticmethod
    def _apply_rlimit(res: int, value: int) -> None:
        """Set a soft rlimit, clamped to the current hard limit."""
        soft, hard = resource.getrlimit(res)
        new_hard = value if hard == resource.RLIM_INFINITY else min(value, hard)
        new_soft = min(value, new_hard)
        resource.setrlimit(res, (new_soft, new_hard))

    def _make_preexec(self):
        """Layer 3: returns a preexec_fn that applies OS resource limits in
        the child process before exec."""
        cpu = self.cpu_limit
        fsize = self.fsize_limit_bytes
        mem_bytes = self.memory_limit_mb * 1024 * 1024 if self.memory_limit_mb else None

        def _preexec() -> None:
            if cpu is not None:
                try:
                    self._apply_rlimit(resource.RLIMIT_CPU, cpu)
                except Exception:
                    pass
            try:
                self._apply_rlimit(resource.RLIMIT_FSIZE, fsize)
            except Exception:
                pass
            if mem_bytes is not None:
                try:
                    self._apply_rlimit(resource.RLIMIT_AS, mem_bytes)
                except Exception:
                    pass

        return _preexec

    def _execute_sandbox(
        self,
        code: str,
        data: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Execute code in a subprocess sandbox with layered restrictions."""
        data_json = json.dumps(data, ensure_ascii=False, default=str)
        full_script = self._build_script(code)

        script_path = None
        work_dir = None
        try:
            work_dir = tempfile.mkdtemp(prefix="sandbox_")
            # Write script inside the isolated working directory
            with open(os.path.join(work_dir, "run.py"), "w", encoding="utf-8") as f:
                f.write(full_script)
                script_path = f.name

            # Layer 4: minimal environment + isolated cwd + -E (ignore PYTHON* env)
            child_env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
            }

            result = subprocess.run(
                [sys.executable, "-E", script_path],
                input=data_json[:50000],
                capture_output=True,
                text=True,
                timeout=self.timeout,
                cwd=work_dir,
                env=child_env,
                preexec_fn=self._make_preexec(),
            )

            if result.returncode == 0:
                try:
                    output = json.loads(result.stdout.strip().split('\n')[-1])
                    return {
                        'success': output['success'],
                        'output': output['result'],
                    }
                except (json.JSONDecodeError, IndexError, KeyError):
                    return {
                        'success': True,
                        'output': result.stdout[:500],
                    }
            else:
                return {
                    'success': False,
                    'output': result.stderr[:500],
                    'error': f'Exit code: {result.returncode}',
                }

        except subprocess.TimeoutExpired:
            return {
                'success': False,
                'output': f'代码执行超时 ({self.timeout}秒)',
                'error': 'timeout',
            }
        except Exception as e:
            return {
                'success': False,
                'output': f'执行失败: {str(e)}',
                'error': str(e),
            }
        finally:
            import shutil
            if script_path:
                Path(script_path).unlink(missing_ok=True)
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)
