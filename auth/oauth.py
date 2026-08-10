"""
OAuth clients for WeChat (微信) and GitHub.

Flow:
    1. Frontend redirects user to provider's authorize URL
    2. Provider redirects back with code
    3. Backend exchanges code for access_token
    4. Backend fetches user profile

Environment variables needed:
    WECHAT_APP_ID, WECHAT_APP_SECRET, WECHAT_REDIRECT_URI
    GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI
"""

from __future__ import annotations

import os
import time
import logging
import httpx
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("auth.oauth")


@dataclass
class OAuthUserInfo:
    """Normalized user info from any OAuth provider."""
    provider: str
    provider_user_id: str      # WeChat openid / GitHub node_id
    username: str
    email: Optional[str]
    avatar_url: Optional[str]
    raw: dict


# ========================================================================
# WeChat OAuth (微信开放平台 — 网站应用扫码登录)
# ========================================================================

WECHAT_APP_ID = os.getenv("WECHAT_APP_ID", "")
WECHAT_APP_SECRET = os.getenv("WECHAT_APP_SECRET", "")
WECHAT_REDIRECT_URI = os.getenv("WECHAT_REDIRECT_URI", "")

WECHAT_AUTH_URL = "https://open.weixin.qq.com/connect/qrconnect"
WECHAT_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token"
WECHAT_USER_URL = "https://api.weixin.qq.com/sns/userinfo"


def get_wechat_auth_url(state: str) -> str:
    """Generate WeChat QR scan authorize URL."""
    from urllib.parse import urlencode
    params = urlencode({
        "appid": WECHAT_APP_ID,
        "redirect_uri": WECHAT_REDIRECT_URI,
        "response_type": "code",
        "scope": "snsapi_login",
        "state": state,
    })
    return f"{WECHAT_AUTH_URL}?{params}"


async def wechat_get_user_info(code: str) -> OAuthUserInfo:
    """Exchange WeChat auth code for user info."""
    async with httpx.AsyncClient() as client:
        # Step 1: code → access_token + openid
        resp = await client.get(WECHAT_TOKEN_URL, params={
            "appid": WECHAT_APP_ID,
            "secret": WECHAT_APP_SECRET,
            "code": code,
            "grant_type": "authorization_code",
        })
        resp.raise_for_status()
        token_data = resp.json()

        if "errcode" in token_data:
            raise ValueError(f"WeChat token error: {token_data}")

        access_token = token_data["access_token"]
        openid = token_data["openid"]

        # Step 2: access_token + openid → user info
        resp = await client.get(WECHAT_USER_URL, params={
            "access_token": access_token,
            "openid": openid,
            "lang": "zh_CN",
        })
        resp.raise_for_status()
        user_data = resp.json()

        if "errcode" in user_data:
            raise ValueError(f"WeChat userinfo error: {user_data}")

    return OAuthUserInfo(
        provider="wechat",
        provider_user_id=openid,
        username=user_data.get("nickname", "微信用户"),
        email=None,  # WeChat doesn't provide email
        avatar_url=user_data.get("headimgurl"),
        raw=user_data,
    )


# ========================================================================
# GitHub OAuth
# ========================================================================

GITHUB_CLIENT_ID = os.getenv("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.getenv("GITHUB_CLIENT_SECRET", "")
GITHUB_REDIRECT_URI = os.getenv("GITHUB_REDIRECT_URI", "")

GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"


def get_github_auth_url(state: str) -> str:
    """Generate GitHub authorize URL."""
    from urllib.parse import urlencode
    params = urlencode({
        "client_id": GITHUB_CLIENT_ID,
        "redirect_uri": GITHUB_REDIRECT_URI,
        "scope": "read:user user:email",
        "state": state,
    })
    return f"{GITHUB_AUTH_URL}?{params}"


async def github_get_user_info(code: str) -> OAuthUserInfo:
    """Exchange GitHub auth code for user info."""
    async with httpx.AsyncClient() as client:
        # Step 1: code → access_token
        resp = await client.post(GITHUB_TOKEN_URL, json={
            "client_id": GITHUB_CLIENT_ID,
            "client_secret": GITHUB_CLIENT_SECRET,
            "code": code,
            "redirect_uri": GITHUB_REDIRECT_URI,
        }, headers={"Accept": "application/json"})
        resp.raise_for_status()
        token_data = resp.json()

        if "error" in token_data:
            raise ValueError(f"GitHub token error: {token_data}")

        access_token = token_data["access_token"]

        # Step 2: access_token → user profile
        resp = await client.get(GITHUB_USER_URL, headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json",
        })
        resp.raise_for_status()
        user_data = resp.json()

        # Step 3: fetch primary email (if email is null)
        email = user_data.get("email")
        if not email:
            resp = await client.get("https://api.github.com/user/emails", headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
            })
            if resp.status_code == 200:
                emails = resp.json()
                primary = next((e for e in emails if e.get("primary")), None)
                if primary:
                    email = primary["email"]

    return OAuthUserInfo(
        provider="github",
        provider_user_id=str(user_data["id"]),
        username=user_data.get("login", "github-user"),
        email=email,
        avatar_url=user_data.get("avatar_url"),
        raw=user_data,
    )


# ========================================================================
# Unified Interface
# ========================================================================

def get_auth_url(provider: str, state: str) -> str:
    if provider == "wechat":
        return get_wechat_auth_url(state)
    elif provider == "github":
        return get_github_auth_url(state)
    raise ValueError(f"Unknown provider: {provider}")


async def get_oauth_user_info(provider: str, code: str) -> OAuthUserInfo:
    if provider == "wechat":
        return await wechat_get_user_info(code)
    elif provider == "github":
        return await github_get_user_info(code)
    raise ValueError(f"Unknown provider: {provider}")
