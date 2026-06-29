from __future__ import annotations

import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_SCRIPT = REPO_ROOT / "scripts" / "run-nightly-source-refresh.ps1"
REGISTER_SCRIPT = REPO_ROOT / "scripts" / "register-nightly-source-refresh-task.ps1"
STUB_CMD = REPO_ROOT / "scripts" / "test-nightly-refresh-stub.cmd"


def _run_nightly_stub(tmp_path: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    log_path = tmp_path / "nightly.log"
    return subprocess.run(
        [
            "powershell",
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


def test_register_nightly_task_prepares_duplicate_index_by_default() -> None:
    result = subprocess.run(
        [
            "powershell",
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