from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path


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
        return {"username": lines[0].strip(), "password": lines[1].strip()}
    return {
        "username": str(payload.get("username") or "").strip(),
        "password": str(payload.get("password") or "").strip(),
    }


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
                    "input[name='password'], input[type='password'], select, button:has-text('NEXT'), button:has-text('Next'), text=NEXT, text=Next",
                    timeout=20000,
                )
            except Exception:
                pass

    if password:
        started_at = time.monotonic()
        while time.monotonic() - started_at < 90:
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


def refresh_cookie_file(*, base_url: str, cookie_file: Path, headless: bool) -> None:
    from playwright.sync_api import sync_playwright

    cookie_file.parent.mkdir(parents=True, exist_ok=True)
    login_info = _load_login_info()
    profile_dir = Path(os.environ.get("VIZION_OCTANE_BROWSER_PROFILE", str(cookie_file.parent / ".octane-browser-profile")))
    profile_dir.mkdir(parents=True, exist_ok=True)
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
            try:
                page.goto(f"{base_url.rstrip('/')}/api/shared_spaces/1002/workspaces/2001/teams?limit=1&fields=id,name", timeout=60000)
                page.wait_for_load_state("networkidle", timeout=30000)
            except Exception:
                pass
            cookies = context.cookies()
            cookie_header = request_cookie_header or _cookie_header_from_cookies(cookies, base_url=base_url)
            if not cookie_header:
                raise RuntimeError("No cookie was captured from Playwright context")
            cookie_file.write_text(cookie_header, encoding="utf-8")
        finally:
            context.close()


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