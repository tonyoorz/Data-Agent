"""Unit tests for `two_digit_code` in scripts/sem_accuracy_analysis.py.

The function extracts the first two-digit number from a phase / BI name such as
``"03-In Analysis"`` and returns it as a string (e.g. ``"03"``). These tests
cover the requested case plus the edge cases implied by the implementation.
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

# `sem_accuracy_analysis.py` lives under `scripts/`, which is not a Python
# package (no __init__.py) and is not on sys.path. Load it directly by path so
# the test works regardless of where pytest is invoked from.
#
# The module replaces `sys.stdout` at import time: it wraps `sys.stdout.buffer`
# to force UTF-8 output on Windows. Under pytest's output capture `sys.stdout`
# is a `StringIO` (no `.buffer`) or a capture object whose file descriptor the
# rewrap corrupts, raising "ValueError: I/O operation on closed file" at
# teardown. So during the import we swap in a throwaway stdout that exposes a
# real `.buffer` (a BytesIO), let the module wrap that, then restore the real
# stdout. Nothing the module writes during import escapes to pytest's capture.


class _ImportStdout(io.TextIOWrapper):
    """A disposable stdout for module import: has a real `.buffer`."""

    def __init__(self) -> None:
        super().__init__(io.BytesIO(), encoding="utf-8", line_buffering=True)


_SCRIPT_PATH = (
    Path(__file__).resolve().parent.parent.parent / "scripts" / "sem_accuracy_analysis.py"
)
_real_stdout = sys.stdout
sys.stdout = _ImportStdout()
try:
    _spec = importlib.util.spec_from_file_location("sem_accuracy_analysis", _SCRIPT_PATH)
    assert _spec is not None and _spec.loader is not None, f"cannot load {_SCRIPT_PATH}"
    _module = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_module)
finally:
    sys.stdout = _real_stdout

two_digit_code = _module.two_digit_code


# --- the case the user asked about ------------------------------------------- #
def test_extracts_03_from_phase_name() -> None:
    """'03-In Analysis' must yield '03'."""
    assert two_digit_code("03-In Analysis") == "03"


# --- representative phases (per the docstring's phase table) ----------------- #
@pytest.mark.parametrize(
    "name, expected",
    [
        ("01-New", "01"),
        ("02-In Pre-Analysis", "02"),
        ("03-In Analysis", "03"),
        ("04-In Implementation", "04"),
        ("10-In Testing", "10"),
        ("00-Done", "00"),
    ],
)
def test_phase_code_table(name: str, expected: str) -> None:
    assert two_digit_code(name) == expected


# --- the function only ever returns the *first* two-digit run ---------------- #
def test_takes_first_two_digit_run() -> None:
    # `re.compile(r"^\D*(\d{2})")` — leading non-digits, then first 2 digits.
    assert two_digit_code("Phase 12 - 34") == "12"


def test_single_digit_not_matched() -> None:
    # A lone single digit is NOT a two-digit code; the regex requires exactly 2.
    assert two_digit_code("3-In Analysis") is None


def test_three_or_more_digits_yield_first_two() -> None:
    # The pattern grabs the first two digits even when more follow.
    assert two_digit_code("123-Long") == "12"


def test_no_digits_returns_none() -> None:
    assert two_digit_code("In Analysis") is None


# --- falsy / odd inputs are coerced to a string, never crash ----------------- #
@pytest.mark.parametrize(
    "value",
    [None, "", "   ", 0, 0.0, "0"],
)
def test_falsy_or_zero_like(value: object) -> None:
    # None / "" / whitespace -> None. The int 0 becomes "0" -> no 2-digit run.
    assert two_digit_code(value) is None


def test_non_string_numeric_input() -> None:
    # str(30) == "30", which is a two-digit code.
    assert two_digit_code(30) == "30"


def test_whitespace_is_stripped() -> None:
    assert two_digit_code("   03-In Analysis   ") == "03"
