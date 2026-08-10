from __future__ import annotations

import argparse
import json
import os
import subprocess
import threading
import tempfile
import time
from pathlib import Path


_OCTANE_AUTH_COOKIE_NAMES = {"access_token", "OCTANE_USER", "JSESSIONID"}


def _load_login_info() -> dict[str, str]:
    from backend.analytics.config import get_octane_login_file_path

    login_file = get_octane_login_file_path()
    if not login_file.exists():
        return {}
    try:
        payload = json.loads(login_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        lines = login_file.read_text(encoding="utf-8").splitlines()
        if len(lines) < 2:
            return {}
        payload = {"username": lines[0].strip(), "password": lines[1].strip()}
        if len(lines) >= 3:
            payload["windows_hello_pin"] = lines[2].strip()
        return payload
    return {
        "username": str(payload.get("username") or "").strip(),
        "password": str(payload.get("password") or "").strip(),
        "windows_hello_pin": str(
            payload.get("windows_hello_pin") or payload.get("windows_pin") or payload.get("pin") or ""
        ).strip(),
    }


def _windows_hello_pin_from_login_info(login_info: dict[str, str]) -> str:
    return str(
        login_info.get("windows_hello_pin")
        or login_info.get("windows_pin")
        or login_info.get("pin")
        or ""
    ).strip()


def _try_handle_windows_security_pin(pin: str) -> bool:
    normalized_pin = str(pin or "").strip()
    if not normalized_pin or os.name != "nt":
        return False

    script = r'''
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NativeUiClick { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra); }'
[NativeUiClick]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$pin = $env:VIZION_WINDOWS_HELLO_PIN
if ([string]::IsNullOrWhiteSpace($pin)) { exit 2 }

function Find-WindowsSecurityWindow {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $children = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($child in $children) {
        try {
            if ([string]$child.Current.Name -eq 'Windows Security') { return $child }
        }
        catch {}
    }
    foreach ($child in $children) {
        try {
            if ([string]$child.Current.ClassName -ne 'Chrome_WidgetWin_1') { continue }
            $descendants = $child.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($element in $descendants) {
                try {
                    if (
                        [string]$element.Current.Name -eq 'Windows Security' -and
                        [string]$element.Current.ClassName -eq 'Credential Dialog Xaml Host'
                    ) {
                        [NativeUiClick]::SetForegroundWindow([IntPtr]$child.Current.NativeWindowHandle) | Out-Null
                        return $element
                    }
                }
                catch {}
            }
        }
        catch {}
    }
    return $null
}

function Find-DescendantByNamePattern($root, [string]$pattern) {
    if ($null -eq $root) { return $null }
    $elements = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($element in $elements) {
        try {
            if ([string]$element.Current.Name -match $pattern) { return $element }
        }
        catch {}
    }
    return $null
}

function Invoke-AutomationElement($element) {
    if ($null -eq $element) { return $false }
    $invokePattern = $null
    try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
            $invokePattern.Invoke()
            return $true
        }
    }
    catch {}
    $selectionPattern = $null
    try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
            $selectionPattern.Select()
            return $true
        }
    }
    catch {}
    return $false
}

function Click-Relative($element, [double]$xRatio, [double]$yRatio) {
    if ($null -eq $element) { return $false }
    try {
        $rect = $element.Current.BoundingRectangle
        $x = [int]($rect.X + ($rect.Width * $xRatio))
        $y = [int]($rect.Y + ($rect.Height * $yRatio))
        [NativeUiClick]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 80
        [NativeUiClick]::mouse_event(0x02, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 40
        [NativeUiClick]::mouse_event(0x04, 0, 0, 0, 0)
        return $true
    }
    catch {}
    return $false
}

function Click-RelativeCandidates($element, $candidates) {
    foreach ($candidate in $candidates) {
        try {
            if (Click-Relative $element ([double]$candidate[0]) ([double]$candidate[1])) {
                Start-Sleep -Milliseconds 250
            }
        }
        catch {}
    }
    return $true
}

$deadline = (Get-Date).AddSeconds(20)
$window = $null
while ((Get-Date) -lt $deadline) {
    $window = Find-WindowsSecurityWindow
    if ($null -ne $window) { break }
    Start-Sleep -Milliseconds 250
}
if ($null -eq $window) { exit 3 }

$options = Find-DescendantByNamePattern $window '(?i)sign.?in options'
if (-not (Invoke-AutomationElement $options)) {
    if (-not (Click-RelativeCandidates $window @(
        @(0.36, 0.58), @(0.43, 0.58), @(0.50, 0.58), @(0.57, 0.58),
        @(0.36, 0.62), @(0.43, 0.62), @(0.50, 0.62), @(0.57, 0.62),
        @(0.36, 0.66), @(0.43, 0.66), @(0.50, 0.66), @(0.57, 0.66)
    ))) { exit 4 }
}
Start-Sleep -Milliseconds 1200

$window = Find-WindowsSecurityWindow
$pinOption = Find-DescendantByNamePattern $window '(?i)\bPIN\b'
if (-not (Invoke-AutomationElement $pinOption)) {
    if (-not (Click-RelativeCandidates $window @(
        @(0.56, 0.61), @(0.58, 0.61), @(0.60, 0.61),
        @(0.56, 0.63), @(0.58, 0.63), @(0.60, 0.63),
        @(0.56, 0.65), @(0.58, 0.65), @(0.60, 0.65)
    ))) { exit 5 }
}
Start-Sleep -Milliseconds 800

[System.Windows.Forms.SendKeys]::SendWait($pin)
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output 'windows-security-pin-submitted'
exit 0
'''
    env = os.environ.copy()
    env["VIZION_WINDOWS_HELLO_PIN"] = normalized_pin
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"],
        input=script,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        env=env,
    )
    return result.returncode == 0


def _start_windows_security_pin_watcher(pin: str) -> threading.Event | None:
    normalized_pin = str(pin or "").strip()
    if not normalized_pin or os.name != "nt":
        return None

    stop_event = threading.Event()

    def watch() -> None:
        deadline = time.monotonic() + 150
        while not stop_event.is_set() and time.monotonic() < deadline:
            if _try_handle_windows_security_pin(normalized_pin):
                return
            stop_event.wait(1)

    thread = threading.Thread(target=watch, name="windows-security-pin-watcher", daemon=True)
    thread.start()
    return stop_event


def _try_fill_first(page, selectors: tuple[str, ...], value: str) -> bool:
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            if locator.count() <= 0:
                continue
            locator.fill(value, timeout=3000)
            return True
        except Exception:
            continue
    return False


def _try_click_first(page, selectors: tuple[str, ...]) -> bool:
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            if locator.count() <= 0:
                continue
            locator.click(timeout=3000)
            return True
        except Exception:
            continue
    return False


def _has_auth_method_select(page) -> bool:
    try:
        return page.locator("select").count() > 0
    except Exception:
        return False


def _is_auth_method_page(page) -> bool:
    if _has_auth_method_select(page):
        return True
    for selector in (
        "text=Please select the authentication method",
        "text=authentication method",
        "text=Security key / Passkey",
    ):
        try:
            if page.locator(selector).count() > 0:
                return True
        except Exception:
            continue
    return False


def _try_select_password_auth_method(page) -> bool:
    try:
        select_locators = page.locator("select")
        select_count = select_locators.count()
        if select_count <= 0:
            return False
    except Exception:
        return False

    for select_index in range(select_count):
        try:
            select_locator = select_locators.nth(select_index) if hasattr(select_locators, "nth") else select_locators.first
            options = select_locator.evaluate(
                "select => Array.from(select.options).map(option => ({ label: option.textContent || option.label || '', value: option.value || '', selected: option.selected }))"
            )
        except Exception:
            continue

        for option in list(options or []):
            if not isinstance(option, dict):
                continue
            label = str(option.get("label") or "").strip()
            value = str(option.get("value") or "").strip()
            if "password" not in f"{label} {value}".lower():
                continue
            try:
                if value:
                    select_locator.select_option(value=value, timeout=3000)
                else:
                    select_locator.select_option(label=label, timeout=3000)
                try:
                    select_locator.evaluate(
                        """
                        (select, expected) => {
                            const options = Array.from(select.options);
                            const option = options.find(item => `${item.textContent || item.label || ''} ${item.value || ''}`.toLowerCase().includes(expected));
                            if (option) {
                                select.value = option.value;
                                option.selected = true;
                                select.dispatchEvent(new Event('input', { bubbles: true }));
                                select.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }
                        """,
                        "password",
                    )
                except Exception:
                    pass
                selected_options = select_locator.evaluate(
                    "select => Array.from(select.selectedOptions).map(option => ({ label: option.textContent || option.label || '', value: option.value || '' }))"
                )
                selected_text = " ".join(
                    f"{str(item.get('label') or '')} {str(item.get('value') or '')}"
                    for item in list(selected_options or [])
                    if isinstance(item, dict)
                ).lower()
                if "password" in selected_text:
                    return True
            except Exception:
                continue
    return False


def _wait_for_password_auth_method(page, *, timeout_seconds: float = 30) -> bool:
    started_at = time.monotonic()
    while time.monotonic() - started_at < timeout_seconds:
        if _try_continue_after_auth_method_selection(page):
            return True
        if not _is_auth_method_page(page):
            return False
        try:
            page.wait_for_timeout(1000)
        except Exception:
            time.sleep(1)
    return False


def _try_continue_after_auth_method_selection(page) -> bool:
    if not _try_select_password_auth_method(page):
        return False
    clicked = _try_click_first(
        page,
        (
            "button[type='submit']",
            "input[type='submit']",
            "button:has-text('NEXT')",
            "button:has-text('Next')",
            "text=NEXT",
            "text=Next",
        ),
    )
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    try:
        page.wait_for_selector(
            "input[name='password'], input[type='password'], input[id*='password' i], input[name*='password' i]",
            timeout=20000,
        )
    except Exception:
        pass
    return clicked


def _try_select_other_sign_in_option(page) -> bool:
    clicked = _try_click_first(
        page,
        (
            "text=Sign in other option",
            "text=Sign in other options",
            "text=Sign in another way",
            "text=Use another option",
            "text=Other sign-in options",
            "text=Use your password",
            "button:has-text('Sign in other option')",
            "button:has-text('Sign in other options')",
            "button:has-text('Sign in another way')",
            "button:has-text('Use another option')",
            "button:has-text('Other sign-in options')",
            "button:has-text('Use your password')",
        ),
    )
    if not clicked:
        return False
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    try:
        page.wait_for_selector(
            "input[name='password'], input[type='password'], input[id*='password' i], input[name*='password' i]",
            timeout=20000,
        )
    except Exception:
        pass
    return True


def _try_submit_login(page, *, username: str, password: str) -> None:
    if username:
        filled_user = _try_fill_first(
            page,
            (
                "input[name='username']",
                "input[type='email']",
                "input[type='text']",
                "input[name*='user' i]",
            ),
            username,
        )
        if filled_user:
            if not _try_click_first(page, ("button[type='submit']", "input[type='submit']", "text=NEXT", "text=Next")):
                try:
                    page.keyboard.press("Enter")
                except Exception:
                    pass
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            try:
                page.wait_for_selector(
                    "input[name='password'], input[type='password'], select, button:has-text('NEXT'), button:has-text('Next'), text=NEXT, text=Next, text=Sign in other option, text=Sign in another way, text=Use another option",
                    timeout=20000,
                )
            except Exception:
                pass
            _wait_for_password_auth_method(page)
            _try_select_other_sign_in_option(page)

    if password:
        started_at = time.monotonic()
        while time.monotonic() - started_at < 90:
            _try_continue_after_auth_method_selection(page)
            _try_select_other_sign_in_option(page)
            filled_password = _try_fill_first(
                page,
                (
                    "input[name='password']",
                    "input[type='password']",
                    "input[id*='password' i]",
                    "input[name*='password' i]",
                ),
                password,
            )
            if filled_password:
                if not _try_click_first(
                    page,
                    (
                        "button[type='submit']",
                        "input[type='submit']",
                        "button:has-text('Sign in')",
                        "button:has-text('Log in')",
                        "button:has-text('LOGIN')",
                        "text=Sign in",
                        "text=Log in",
                    ),
                ):
                    try:
                        page.keyboard.press("Enter")
                    except Exception:
                        pass
                break
            if not _is_auth_method_page(page):
                _try_click_first(
                    page,
                    (
                        "button:has-text('NEXT')",
                        "button:has-text('Next')",
                        "input[type='submit']",
                        "text=NEXT",
                        "text=Next",
                    ),
                )
            try:
                page.wait_for_selector(
                    "input[name='password'], input[type='password'], input[id*='password' i], input[name*='password' i]",
                    timeout=5000,
                )
            except Exception:
                pass
            time.sleep(1)


def _cookie_header_from_cookies(cookies: list[dict[str, object]], *, base_url: str) -> str:
    host = base_url.split("://", 1)[-1].split("/", 1)[0].lower()
    filtered = []
    for cookie in cookies:
        name = str(cookie.get("name") or "").strip()
        if not name:
            continue
        domain = str(cookie.get("domain") or "").strip().lstrip(".").lower()
        if domain and host.endswith(domain):
            filtered.append(cookie)
    selected = filtered or [cookie for cookie in cookies if str(cookie.get("name") or "").strip()]
    return "; ".join(
        f"{str(cookie.get('name') or '').strip()}={str(cookie.get('value') or '')}"
        for cookie in selected
        if str(cookie.get("name") or "").strip()
    )


def _cookie_names_from_header(cookie_header: str) -> list[str]:
    names: list[str] = []
    for part in str(cookie_header or "").split(";"):
        cookie_part = part.strip()
        if not cookie_part or "=" not in cookie_part:
            continue
        cookie_name, _ = cookie_part.split("=", 1)
        cookie_name = cookie_name.strip()
        if cookie_name:
            names.append(cookie_name)
    return names


def _has_octane_auth_cookie(cookie_header: str) -> bool:
    return any(name in _OCTANE_AUTH_COOKIE_NAMES for name in _cookie_names_from_header(cookie_header))


def refresh_cookie_file(*, base_url: str, cookie_file: Path, headless: bool) -> None:
    from playwright.sync_api import sync_playwright

    cookie_file.parent.mkdir(parents=True, exist_ok=True)
    login_info = _load_login_info()
    configured_profile_dir = str(os.environ.get("VIZION_OCTANE_BROWSER_PROFILE") or "").strip()
    temporary_profile_dir: tempfile.TemporaryDirectory[str] | None = None
    if configured_profile_dir:
        profile_dir = Path(configured_profile_dir)
        profile_dir.mkdir(parents=True, exist_ok=True)
    else:
        temporary_profile_dir = tempfile.TemporaryDirectory(prefix="vizion-octane-profile-")
        profile_dir = Path(temporary_profile_dir.name)
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile_dir),
                headless=headless,
                ignore_https_errors=True,
            )
            try:
                page = context.new_page()
                request_cookie_header: str | None = None

                def capture_api_cookie(route, request):
                    nonlocal request_cookie_header
                    header_value = request.headers.get("cookie")
                    if header_value:
                        request_cookie_header = header_value
                    route.continue_()

                context.route("**/api/shared_spaces/**", capture_api_cookie)
                page.goto(base_url, timeout=60000)
                try:
                    page.wait_for_load_state("networkidle", timeout=60000)
                except Exception:
                    pass
                windows_hello_pin = _windows_hello_pin_from_login_info(login_info)
                pin_watcher_stop = None if headless else _start_windows_security_pin_watcher(windows_hello_pin)
                _try_submit_login(
                    page,
                    username=str(login_info.get("username") or "").strip(),
                    password=str(login_info.get("password") or "").strip(),
                )
                if not headless:
                    page.wait_for_timeout(90000)
                try:
                    page.wait_for_load_state("networkidle", timeout=60000)
                except Exception:
                    pass
                api_url = f"{base_url.rstrip('/')}/api/shared_spaces/1002/workspaces/2001/teams?limit=1&fields=id,name"
                api_status: int | None = None
                cookie_header = ""
                attempts = 1 if headless else 6
                for attempt_index in range(attempts):
                    try:
                        response = page.goto(api_url, timeout=60000)
                        api_status = response.status if response is not None else None
                        page.wait_for_load_state("networkidle", timeout=30000)
                    except Exception:
                        pass

                    context_cookie_header = _cookie_header_from_cookies(context.cookies(), base_url=base_url)
                    cookie_header = request_cookie_header if _has_octane_auth_cookie(str(request_cookie_header or "")) else context_cookie_header
                    if api_status == 200 and _has_octane_auth_cookie(cookie_header):
                        cookie_file.write_text(cookie_header, encoding="utf-8")
                        return
                    if attempt_index + 1 < attempts:
                        page.wait_for_timeout(10000)

                if not cookie_header:
                    raise RuntimeError("No cookie was captured from Playwright context")
                title = ""
                try:
                    title = page.title()
                except Exception:
                    pass
                raise RuntimeError(
                    "Playwright Octane login did not produce a validated auth cookie "
                    f"(api_status={api_status}, current_url={page.url!r}, title={title!r}, "
                    f"cookie_names={_cookie_names_from_header(cookie_header)})"
                )
            finally:
                if "pin_watcher_stop" in locals() and pin_watcher_stop is not None:
                    pin_watcher_stop.set()
                context.close()
    finally:
        if temporary_profile_dir is not None:
            temporary_profile_dir.cleanup()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--cookie-file", required=True)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args(argv)
    refresh_cookie_file(
        base_url=args.base_url,
        cookie_file=Path(args.cookie_file),
        headless=bool(args.headless),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())