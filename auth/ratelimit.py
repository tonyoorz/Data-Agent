"""
Rate limiting middleware — simple in-memory sliding window limiter.

Limits:
    - Auth endpoints (/auth/login, /auth/register): 10 req/min per IP
    - API endpoints (/api/*): 100 req/min per user
    - Global: 200 req/min per IP

Configure via environment:
    RATE_LIMIT_ENABLED=1
"""

from __future__ import annotations

import os
import time
import collections
import logging
from typing import Optional, Deque

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("auth.ratelimit")

ENABLED = os.getenv("RATE_LIMIT_ENABLED", "0") == "1"

# Limits: (window_seconds, max_requests)
AUTH_LIMIT = (60, 10)     # 10 per minute for auth endpoints
API_LIMIT = (60, 100)     # 100 per minute for API endpoints
GLOBAL_LIMIT = (60, 200)  # 200 per minute globally

# In-memory store: key -> Deque[timestamps]
# In production, use Redis
_store: dict[str, Deque[float]] = collections.defaultdict(collections.deque)


def _check_and_record(key: str, window: int, max_count: int) -> tuple[bool, int]:
    """
    Check if request is within limit and record the timestamp.
    Returns (allowed, remaining).
    """
    now = time.time()
    cutoff = now - window

    dq = _store[key]
    # Purge old entries
    while dq and dq[0] < cutoff:
        dq.popleft()

    if len(dq) >= max_count:
        return False, 0

    dq.append(now)
    return True, max_count - len(dq)


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _get_user_id(request: Request) -> Optional[str]:
    """Extract user ID from JWT in Authorization header (best-effort, no verification)."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:]
    # Quick decode without full verification (just for rate limiting key)
    try:
        from auth.security import decode_token
        payload = decode_token(token)
        return payload.get("sub") if payload else None
    except Exception:
        return None


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding window rate limiter."""

    async def dispatch(self, request: Request, call_next):
        if not ENABLED:
            return await call_next(request)

        path = request.url.path
        ip = _get_client_ip(request)

        # Global limit
        allowed, remaining = _check_and_record(f"global:{ip}", *GLOBAL_LIMIT)
        if not allowed:
            return Response(
                content='{"detail": "请求过于频繁，请稍后再试"}',
                status_code=429,
                media_type="application/json",
                headers={"Retry-After": "60"},
            )

        # Auth endpoints — stricter limit
        if path.startswith("/auth/") and path in (
            "/auth/login", "/auth/register", "/auth/oauth/wechat", "/auth/oauth/github"
        ):
            allowed, remaining = _check_and_record(f"auth:{ip}", *AUTH_LIMIT)
            if not allowed:
                logger.warning(f"Auth rate limit exceeded for IP={ip} path={path}")
                return Response(
                    content='{"detail": "认证请求过于频繁，请稍后再试"}',
                    status_code=429,
                    media_type="application/json",
                    headers={"Retry-After": "60"},
                )

        # API endpoints — per-user limit
        elif path.startswith("/api/"):
            user_id = _get_user_id(request) or ip
            allowed, remaining = _check_and_record(f"api:{user_id}", *API_LIMIT)
            if not allowed:
                return Response(
                    content='{"detail": "API请求过于频繁，请稍后再试"}',
                    status_code=429,
                    media_type="application/json",
                    headers={"Retry-After": "60", "X-RateLimit-Remaining": "0"},
                )

        response = await call_next(request)

        # Add rate limit headers
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response


def cleanup_old_entries(max_age: int = 3600):
    """Periodic cleanup of expired entries. Call from a background task."""
    now = time.time()
    cutoff = now - max_age
    keys_to_check = list(_store.keys())
    for key in keys_to_check:
        dq = _store[key]
        while dq and dq[0] < cutoff:
            dq.popleft()
        if not dq:
            del _store[key]
