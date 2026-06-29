from __future__ import annotations

import json
from pathlib import Path

import requests


def load_cookie_header(cookie_file: Path | str) -> str:
    path = Path(cookie_file)
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"Cookie file is empty: {path}")
    return text


def build_cookie_session(cookie_file: Path | str) -> requests.Session:
    header = load_cookie_header(cookie_file)
    session = requests.Session()
    session.headers.update({"Cookie": header, "User-Agent": "Mozilla/5.0"})
    for part in header.split(";"):
        cookie_part = part.strip()
        if not cookie_part or "=" not in cookie_part:
            continue
        name, value = cookie_part.split("=", 1)
        session.cookies.set(name.strip(), value.strip(), domain=".octane-prod.bmwgroup.net")
    return session


def load_login_info(login_file: Path | str) -> dict[str, str]:
    payload = json.loads(Path(login_file).read_text(encoding="utf-8"))
    return {
        "username": str(payload.get("username") or "").strip(),
        "password": str(payload.get("password") or "").strip(),
    }