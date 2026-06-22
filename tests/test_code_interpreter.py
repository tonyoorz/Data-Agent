"""Tests for Python Code Interpreter"""

import os
import sys
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.interpret.code_interpreter import CodeInterpreter


# ============================================================================
# Safety Check Tests
# ============================================================================

class TestSafetyCheck:

    def setup_method(self):
        self.ci = CodeInterpreter(llm_call_fn=None)

    def test_safe_code(self):
        safety = self.ci._check_safety("import pandas\ndata = [1,2,3]\nresult = sum(data)")
        assert safety['safe'] is True

    def test_forbidden_os(self):
        safety = self.ci._check_safety("import os\nos.system('rm -rf /')")
        assert safety['safe'] is False
        assert 'os' in safety['reason']

    def test_forbidden_open(self):
        safety = self.ci._check_safety("f = open('/etc/passwd')")
        assert safety['safe'] is False

    def test_forbidden_subprocess(self):
        safety = self.ci._check_safety("import subprocess")
        assert safety['safe'] is False

    def test_forbidden_socket(self):
        safety = self.ci._check_safety("import socket")
        assert safety['safe'] is False

    def test_allowed_imports(self):
        for lib in ['pandas', 'numpy', 'math', 're', 'json', 'statistics', 'collections', 'itertools']:
            safety = self.ci._check_safety(f"import {lib}")
            assert safety['safe'] is True, f"{lib} should be allowed"

    def test_forbidden_import(self):
        safety = self.ci._check_safety("import requests")
        assert safety['safe'] is False


# ============================================================================
# Execution Tests
# ============================================================================

class TestExecution:

    def setup_method(self):
        self.ci = CodeInterpreter(llm_call_fn=None)

    def test_simple_data(self):
        """Test fallback code execution with simple data"""
        data = [
            {'name': 'IHU', 'count': 100},
            {'name': 'BCM', 'count': 86},
            {'name': 'ADAS', 'count': 91},
        ]
        result = self.ci.execute('统计各ECU缺陷数量', data)
        assert result['success'] is True
        assert 'IHU' in result['output']

    def test_empty_data(self):
        """Empty data should handle gracefully"""
        result = self.ci.execute('test', [])
        # Fallback returns None for empty data
        assert result['success'] is False or result['output']

    def test_timeout_protection(self):
        """Code that takes too long should timeout"""
        ci = CodeInterpreter(llm_call_fn=None, timeout=2)

        # Generate code that sleeps
        slow_code = """
import time
time.sleep(10)
result = 'done'
"""
        data = [{'x': 1}]
        result = ci._execute_sandbox(slow_code, data)
        assert result['success'] is False
        assert 'timeout' in result.get('error', '').lower() or '超时' in result.get('output', '')


# ============================================================================
# Fallback Code Tests
# ============================================================================

class TestFallbackCode:

    def setup_method(self):
        self.ci = CodeInterpreter(llm_call_fn=None)

    def test_generates_fallback_code(self):
        data = [{'a': 1}, {'a': 2}]
        code = self.ci._fallback_code('test', data)
        assert code is not None
        assert 'data' in code
        assert 'result' in code

    def test_fallback_with_no_data(self):
        code = self.ci._fallback_code('test', [])
        # Empty data returns None (no meaningful analysis)
        assert code is None or 'result' in code


# ============================================================================
# LLM Code Generation Tests
# ============================================================================

class TestLLMCodeGen:

    def test_mock_llm_simple_code(self):
        """Mock LLM that generates simple Python code"""
        def mock_llm(messages, tools):
            return "result = sum(row.get('count', 0) for row in data)"

        ci = CodeInterpreter(llm_call_fn=mock_llm)
        data = [
            {'name': 'A', 'count': 10},
            {'name': 'B', 'count': 20},
            {'name': 'C', 'count': 30},
        ]
        result = ci.execute('总共有多少', data)
        assert result['success'] is True
        assert '60' in result['output']

    def test_mock_llm_with_markdown_fence(self):
        """LLM returns code in markdown fence"""
        def mock_llm(messages, tools):
            return "```python\nresult = len(data)\n```"

        ci = CodeInterpreter(llm_call_fn=mock_llm)
        result = ci.execute('有多少行', [{'a': 1}, {'a': 2}])
        assert result['success'] is True
        assert '2' in result['output']

    def test_mock_llm_pandas_analysis(self):
        """LLM uses pandas for analysis"""
        def mock_llm(messages, tools):
            return textwrap_code()

        def textwrap_code():
            import textwrap
            return textwrap.dedent("""\
                import pandas as pd
                df = pd.DataFrame(data)
                top = df.nlargest(1, 'count').iloc[0]
                result = f"最多的是{top['name']}，有{top['count']}个"
            """)

        ci = CodeInterpreter(llm_call_fn=mock_llm)
        data = [
            {'name': 'IHU', 'count': 100},
            {'name': 'BCM', 'count': 86},
            {'name': 'ADAS', 'count': 91},
        ]
        result = ci.execute('哪个最多', data)
        assert result['success'] is True
        assert 'IHU' in result['output']
        assert '100' in result['output']


# ============================================================================
# Integration Test
# ============================================================================

class TestIntegration:

    def test_defect_analysis(self):
        """Simulate defect analysis scenario"""
        data = [
            {'ecu': 'IHU', 'severity': 'Critical', 'count': 8},
            {'ecu': 'IHU', 'severity': 'Major', 'count': 50},
            {'ecu': 'BCM', 'severity': 'Critical', 'count': 3},
            {'ecu': 'BCM', 'severity': 'Major', 'count': 40},
        ]

        ci = CodeInterpreter(llm_call_fn=None)
        result = ci.execute('各ECU的Critical缺陷数量', data)
        assert result['success'] is True
        # Should show ECU distribution
        assert 'IHU' in result['output'] or 'ecu' in result['output'].lower()
