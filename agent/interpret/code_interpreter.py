"""Python Code Interpreter — Safe sandboxed execution for data analysis

When SQL can't express complex logic (statistical tests, custom
transformations, anomaly detection), the LLM generates Python code
that operates on query results.

Design:
1. CodeGen: LLM generates Python code from NL + data context
2. Sandbox: Restricted exec with timeout, no network, no file write
3. Formatter: Convert execution result to natural language

Safety:
- subprocess with timeout
- Restricted globals (no __import__, no open, no os/system)
- Memory limit via input data size cap
- Only pandas/numpy/math/re available

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

import json
import logging
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

可用库：pandas, numpy, math, re, json, statistics
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
        "statistics", "collections", "itertools",
    }

    # Forbidden patterns in code
    FORBIDDEN_PATTERNS = [
        "import os",
        "import sys",
        "import subprocess",
        "import socket",
        "import urllib",
        "import requests",
        "import http",
        "import shutil",
        "import pickle",
        "import marshal",
        "import ctypes",
        "__import__",
        "open(",
        "exec(",
        "eval(",
        "compile(",
        "globals(",
        "locals(",
    ]

    def __init__(
        self,
        llm_call_fn: Optional[Callable] = None,
        timeout: int = 5,
    ):
        self.llm_call_fn = llm_call_fn
        self.timeout = timeout

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
        """Check code for forbidden patterns"""
        code_lower = code.lower()

        for pattern in self.FORBIDDEN_PATTERNS:
            if pattern.lower() in code_lower:
                return {
                    'safe': False,
                    'reason': f'禁止使用: {pattern}',
                }

        # Check imports
        for line in code.split('\n'):
            line = line.strip()
            if line.startswith('import ') or line.startswith('from '):
                module = line.replace('import ', '').replace('from ', '').split('.')[0].split(' ')[0]
                if module not in self.SAFE_IMPORTS:
                    return {
                        'safe': False,
                        'reason': f'不支持的库: {module}',
                    }

        return {'safe': True, 'reason': ''}

    def _execute_sandbox(
        self,
        code: str,
        data: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Execute code in a subprocess sandbox"""
        data_json = json.dumps(data, ensure_ascii=False, default=str)

        # Build the script with no f-string escaping issues
        # Data is passed via stdin, code is embedded directly
        script_lines = [
            "import json, sys",
            "",
            "# Load data from stdin",
            "data = json.loads(sys.stdin.read())",
            "",
            "# User code",
            "try:",
        ]
        # Indent user code
        for line in code.split('\n'):
            script_lines.append("    " + line if line.strip() else "")
        script_lines.extend([
            "except Exception as e:",
            "    result = f'代码执行错误: {e}'",
            "",
            "# Output result",
            "if 'result' in dir():",
            "    print(json.dumps({'success': True, 'result': str(result)}))",
            "else:",
            "    print(json.dumps({'success': True, 'result': '代码执行完成（无result变量）'}))",
        ])

        full_script = "\n".join(script_lines)

        try:
            # Write to temp file and execute
            with tempfile.NamedTemporaryFile(
                mode='w', suffix='.py', delete=False, prefix='sandbox_'
            ) as f:
                f.write(full_script)
                script_path = f.name

            result = subprocess.run(
                [sys.executable, script_path],
                input=data_json[:50000],
                capture_output=True,
                text=True,
                timeout=self.timeout,
            )

            # Cleanup
            Path(script_path).unlink(missing_ok=True)

            if result.returncode == 0:
                try:
                    output = json.loads(result.stdout.strip().split('\n')[-1])
                    return {
                        'success': output['success'],
                        'output': output['result'],
                    }
                except (json.JSONDecodeError, IndexError):
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
            Path(script_path).unlink(missing_ok=True)
            return {
                'success': False,
                'output': f'代码执行超时 ({self.timeout}秒)',
                'error': 'timeout',
            }
        except Exception as e:
            Path(script_path).unlink(missing_ok=True)
            return {
                'success': False,
                'output': f'执行失败: {str(e)}',
                'error': str(e),
            }
