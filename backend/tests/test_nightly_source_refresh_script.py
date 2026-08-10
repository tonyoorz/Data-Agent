from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_SCRIPT = REPO_ROOT / "scripts" / "run-nightly-source-refresh.ps1"
REGISTER_SCRIPT = REPO_ROOT / "scripts" / "register-nightly-source-refresh-task.ps1"
STUB_CMD = REPO_ROOT / "scripts" / "test-nightly-refresh-stub.cmd"
POWERSHELL_EXE = shutil.which("powershell") or shutil.which("pwsh")

pytestmark = pytest.mark.skipif(
    os.name != "nt" or POWERSHELL_EXE is None,
    reason="nightly refresh integration scripts require Windows PowerShell and cmd.exe",
)


def _run_nightly_stub(tmp_path: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    log_path = tmp_path / "nightly.log"
    return subprocess.run(
        [
            POWERSHELL_EXE or "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(RUN_SCRIPT),
            "-PythonLauncher",
            str(STUB_CMD),
            "-PythonVersion",
            "",
            "-Teams",
            "DTSV_China",
            "-Years",
            "2026",
            "-ManualRunYears",
            "2026",
            "-LogPath",
            str(log_path),
            *extra_args,
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_nightly_source_refresh_includes_comments_by_default(tmp_path: Path) -> None:
    result = _run_nightly_stub(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "skip_comments=False" in result.stdout
    assert "--skip-comments" not in result.stdout


def test_nightly_source_refresh_prepares_duplicate_index_by_default(tmp_path: Path) -> None:
    result = _run_nightly_stub(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "prepare_duplicate_index=True" in result.stdout
    assert "--prepare-duplicate-index" in result.stdout


def test_nightly_source_refresh_can_still_skip_comments_explicitly(tmp_path: Path) -> None:
    result = _run_nightly_stub(tmp_path, "-CommentMode", "skip")

    assert result.returncode == 0, result.stderr
    assert "skip_comments=True" in result.stdout
    assert "--skip-comments" in result.stdout


def test_nightly_source_refresh_defaults_to_2025_through_current_testing_year(tmp_path: Path) -> None:
    log_path = tmp_path / "nightly-default-years.log"
    result = subprocess.run(
        [
            POWERSHELL_EXE or "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(RUN_SCRIPT),
            "-PythonLauncher",
            str(STUB_CMD),
            "-PythonVersion",
            "",
            "-LogPath",
            str(log_path),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    expected_years = ",".join(str(year) for year in range(2025, datetime.now().year + 1))
    assert f"years={expected_years}" in result.stdout
    assert f"manual_years={expected_years}" in result.stdout
    assert f"--years {expected_years}" in result.stdout
    assert f"--manual-years {expected_years}" in result.stdout


def test_register_nightly_task_prepares_duplicate_index_by_default() -> None:
    result = subprocess.run(
        [
            POWERSHELL_EXE or "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(REGISTER_SCRIPT),
            "-PrintCommandOnly",
            "1",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "-PrepareDuplicateIndex 1" in result.stdout
    assert "-NoComments" not in result.stdout
