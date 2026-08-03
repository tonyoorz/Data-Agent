from __future__ import annotations

from pathlib import Path

from backend.analytics.config import (
    get_octane_base_url,
    get_octane_cookie_candidate_paths,
    get_octane_cookie_file_path,
    get_octane_login_file_path,
    resolve_octane_cookie_file_path,
    resolve_octane_login_file_path,
)
from backend.analytics.ingest.auth import build_cookie_session, load_cookie_header
from backend.analytics.ingest import playwright_cookie_manager
from backend.analytics.ingest.playwright_cookie_manager import (
    _cookie_header_from_cookies,
    _has_octane_auth_cookie,
    _try_submit_login,
    _start_windows_security_pin_watcher,
    _try_handle_windows_security_pin,
    _windows_hello_pin_from_login_info,
)


def test_config_defaults_octane_auth_files_to_repo_root(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(tmp_path))

    assert get_octane_cookie_file_path() == tmp_path / "cookie.txt"
    assert get_octane_login_file_path() == tmp_path / "login_info.txt"
    assert get_octane_base_url() == "https://octane-prod.bmwgroup.net"


def test_build_cookie_session_sets_header_and_cookie_jar(tmp_path: Path) -> None:
    cookie_file = tmp_path / "cookie.txt"
    cookie_file.write_text("A=1; B=2", encoding="utf-8")

    session = build_cookie_session(cookie_file)

    assert load_cookie_header(cookie_file) == "A=1; B=2"
    assert session.headers["Cookie"] == "A=1; B=2"
    assert session.trust_env is False
    assert session.cookies.get("A") == "1"
    assert session.cookies.get("B") == "2"


def test_resolve_octane_auth_files_do_not_fall_back_to_sibling_repo(monkeypatch, tmp_path: Path) -> None:
    workspace_root = tmp_path / "vizion-lab"
    workspace_root.mkdir(parents=True)
    sibling_root = tmp_path / "TPMDashbaord"
    sibling_root.mkdir(parents=True)
    (sibling_root / "cookie.txt").write_text("SIBLING_COOKIE=1", encoding="utf-8")
    (sibling_root / "login_info.txt").write_text('{"username": "q1", "password": "pw"}', encoding="utf-8")

    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(workspace_root))

    assert get_octane_cookie_file_path() == workspace_root / "cookie.txt"
    assert get_octane_login_file_path() == workspace_root / "login_info.txt"
    assert get_octane_cookie_candidate_paths() == (workspace_root / "cookie.txt",)
    assert resolve_octane_cookie_file_path() == workspace_root / "cookie.txt"
    assert resolve_octane_login_file_path() == workspace_root / "login_info.txt"


def test_playwright_cookie_header_prefers_octane_domain_cookies() -> None:
    cookie_header = _cookie_header_from_cookies(
        [
            {"name": "unrelated", "value": "skip", "domain": "example.com"},
            {"name": "JSESSIONID", "value": "abc", "domain": ".octane-prod.bmwgroup.net"},
            {"name": "XSRF_COOKIE", "value": "xyz", "domain": "octane-prod.bmwgroup.net"},
        ],
        base_url="https://octane-prod.bmwgroup.net",
    )

    assert cookie_header == "JSESSIONID=abc; XSRF_COOKIE=xyz"


def test_playwright_cookie_header_requires_auth_cookie() -> None:
    assert not _has_octane_auth_cookie("HPECLIENTTYPE=standard; XSRF_COOKIE=csrf")
    assert _has_octane_auth_cookie("JSESSIONID=abc; XSRF_COOKIE=csrf")
    assert _has_octane_auth_cookie("access_token=token; XSRF_COOKIE=csrf")


def test_try_submit_login_selects_other_sign_in_option_before_password(monkeypatch) -> None:
    class FakeKeyboard:
        def __init__(self) -> None:
            self.pressed: list[str] = []

        def press(self, key: str) -> None:
            self.pressed.append(key)

    class FakeLocator:
        def __init__(self, page: "FakePage", selector: str) -> None:
            self.page = page
            self.selector = selector

        @property
        def first(self) -> "FakeLocator":
            return self

        def count(self) -> int:
            return 1

        def fill(self, value: str, timeout: int) -> None:
            if "password" in self.selector.lower() and not self.page.other_option_clicked:
                raise RuntimeError("password field is hidden behind biometric prompt")
            self.page.filled.append((self.selector, value, timeout))

        def click(self, timeout: int) -> None:
            self.page.clicked.append((self.selector, timeout))
            if "other option" in self.selector.lower():
                self.page.other_option_clicked = True

    class FakePage:
        def __init__(self) -> None:
            self.keyboard = FakeKeyboard()
            self.clicked: list[tuple[str, int]] = []
            self.filled: list[tuple[str, str, int]] = []
            self.other_option_clicked = False

        def locator(self, selector: str) -> FakeLocator:
            return FakeLocator(self, selector)

        def wait_for_load_state(self, state: str, timeout: int) -> None:
            return None

        def wait_for_selector(self, selector: str, timeout: int) -> None:
            return None

    monotonic_values = iter([0.0, 0.0, 0.0, 0.0, 91.0])
    monkeypatch.setattr(playwright_cookie_manager.time, "monotonic", lambda: next(monotonic_values, 91.0))
    monkeypatch.setattr(playwright_cookie_manager.time, "sleep", lambda seconds: None)

    page = FakePage()

    _try_submit_login(page, username="q446328", password="secret")

    clicked_selectors = [selector for selector, _ in page.clicked]
    filled_selectors = [selector for selector, _, _ in page.filled]
    assert "text=Sign in other option" in clicked_selectors
    assert "input[name='password']" in filled_selectors


def test_try_submit_login_selects_password_auth_method_before_next(monkeypatch) -> None:
    class FakeKeyboard:
        def press(self, key: str) -> None:
            return None

    class FakeLocator:
        def __init__(self, page: "FakePage", selector: str) -> None:
            self.page = page
            self.selector = selector

        @property
        def first(self) -> "FakeLocator":
            return self

        def count(self) -> int:
            if self.selector == "select":
                return 1
            if "password" in self.selector.lower():
                return 1
            if "next" in self.selector.lower() or self.selector == "button[type='submit']":
                return 1
            return 0

        def evaluate(self, script: str):
            if "selectedOptions" in script:
                return [{"label": "Password", "value": "password"}] if self.page.selected_options else []
            return [
                {"label": "Security key / Passkey", "value": "passkey"},
                {"label": "Password", "value": "password"},
            ]

        def select_option(self, value=None, label=None, timeout: int = 0) -> None:
            self.page.selected_options.append({"value": value, "label": label, "timeout": timeout})

        def fill(self, value: str, timeout: int) -> None:
            if "password" in self.selector.lower() and not self.page.password_method_selected:
                raise RuntimeError("passkey method still selected")
            self.page.filled.append((self.selector, value, timeout))

        def click(self, timeout: int) -> None:
            self.page.clicked.append((self.selector, timeout))
            if "next" in self.selector.lower() or self.selector == "button[type='submit']":
                self.page.password_method_selected = bool(self.page.selected_options)

    class FakePage:
        def __init__(self) -> None:
            self.keyboard = FakeKeyboard()
            self.clicked: list[tuple[str, int]] = []
            self.filled: list[tuple[str, str, int]] = []
            self.selected_options: list[dict[str, object]] = []
            self.password_method_selected = False

        def locator(self, selector: str) -> FakeLocator:
            return FakeLocator(self, selector)

        def wait_for_load_state(self, state: str, timeout: int) -> None:
            return None

        def wait_for_selector(self, selector: str, timeout: int) -> None:
            return None

    monotonic_values = iter([0.0, 0.0, 0.0, 0.0, 91.0])
    monkeypatch.setattr(playwright_cookie_manager.time, "monotonic", lambda: next(monotonic_values))

    page = FakePage()

    _try_submit_login(page, username="q446328", password="secret")

    assert {"value": "password", "label": None, "timeout": 3000} in page.selected_options
    assert "input[name='password']" in [selector for selector, _, _ in page.filled]


def test_try_submit_login_does_not_click_next_when_auth_method_is_unselected(monkeypatch) -> None:
    class FakeKeyboard:
        def press(self, key: str) -> None:
            return None

    class FakeLocator:
        def __init__(self, page: "FakePage", selector: str) -> None:
            self.page = page
            self.selector = selector

        @property
        def first(self) -> "FakeLocator":
            return self

        def count(self) -> int:
            if self.selector == "select":
                return 1
            if "next" in self.selector.lower():
                return 1
            if "password" in self.selector.lower():
                return 0
            return 0

        def evaluate(self, script: str):
            return [{"label": "Security key / Passkey", "value": "passkey"}]

        def select_option(self, value=None, label=None, timeout: int = 0) -> None:
            self.page.selected_options.append({"value": value, "label": label, "timeout": timeout})

        def fill(self, value: str, timeout: int) -> None:
            raise RuntimeError("password field not available")

        def click(self, timeout: int) -> None:
            self.page.clicked.append((self.selector, timeout))

    class FakePage:
        def __init__(self) -> None:
            self.keyboard = FakeKeyboard()
            self.clicked: list[tuple[str, int]] = []
            self.selected_options: list[dict[str, object]] = []

        def locator(self, selector: str) -> FakeLocator:
            return FakeLocator(self, selector)

        def wait_for_load_state(self, state: str, timeout: int) -> None:
            return None

        def wait_for_selector(self, selector: str, timeout: int) -> None:
            return None

    monotonic_values = iter([0.0, 0.0, 91.0])
    monkeypatch.setattr(playwright_cookie_manager.time, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(playwright_cookie_manager.time, "sleep", lambda seconds: None)

    page = FakePage()

    _try_submit_login(page, username="", password="secret")

    assert page.clicked == []


def test_windows_hello_pin_can_be_read_from_login_info_without_requiring_it() -> None:
    assert _windows_hello_pin_from_login_info({"username": "q446328"}) == ""
    assert _windows_hello_pin_from_login_info({"windows_hello_pin": "123456"}) == "123456"
    assert _windows_hello_pin_from_login_info({"pin": "654321"}) == "654321"


def test_windows_security_pin_handler_keeps_pin_out_of_command_line(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(command, *, input, capture_output, text, timeout, check, env):
        captured["command"] = command
        captured["input"] = input
        captured["env_pin"] = env.get("VIZION_WINDOWS_HELLO_PIN")

        class Result:
            returncode = 0
            stdout = "windows-security-pin-submitted"
            stderr = ""

        return Result()

    monkeypatch.setattr(playwright_cookie_manager.subprocess, "run", fake_run)
    monkeypatch.setattr(playwright_cookie_manager.os, "name", "nt")

    assert _try_handle_windows_security_pin("123456")
    assert captured["env_pin"] == "123456"
    assert "Credential Dialog Xaml Host" in str(captured["input"])
    assert "123456" not in " ".join(captured["command"])
    assert "123456" not in str(captured["input"])


def test_windows_security_pin_watcher_starts_without_exposing_pin(monkeypatch) -> None:
    calls: list[str] = []

    class FakeEvent:
        def __init__(self) -> None:
            self.set_calls = 0

        def is_set(self) -> bool:
            return bool(calls)

        def wait(self, seconds: int) -> None:
            return None

        def set(self) -> None:
            self.set_calls += 1

    class FakeThread:
        def __init__(self, *, target, name, daemon) -> None:
            self.target = target
            self.name = name
            self.daemon = daemon

        def start(self) -> None:
            self.target()

    monkeypatch.setattr(playwright_cookie_manager.os, "name", "nt")
    monkeypatch.setattr(playwright_cookie_manager.threading, "Event", FakeEvent)
    monkeypatch.setattr(playwright_cookie_manager.threading, "Thread", FakeThread)
    monkeypatch.setattr(playwright_cookie_manager, "_try_handle_windows_security_pin", lambda pin: calls.append(pin) or True)

    stop_event = _start_windows_security_pin_watcher("123456")

    assert stop_event is not None
    assert calls == ["123456"]
