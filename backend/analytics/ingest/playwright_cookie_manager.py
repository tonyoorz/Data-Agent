from __future__ import annotations

import argparse
from pathlib import Path


def refresh_cookie_file(*, base_url: str, cookie_file: Path, headless: bool) -> None:
    from playwright.sync_api import sync_playwright

    cookie_file.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        try:
            context = browser.new_context(ignore_https_errors=True)
            page = context.new_page()
            page.goto(base_url, timeout=60000)
            page.wait_for_load_state("networkidle", timeout=60000)
            cookies = context.cookies()
            cookie_header = "; ".join(
                f"{item['name']}={item['value']}"
                for item in cookies
                if item.get("name")
            )
            cookie_file.write_text(cookie_header, encoding="utf-8")
        finally:
            browser.close()


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