"""
Security utilities: JWT tokens, password hashing.

JWT payload structure:
    {
        "sub": user_id,
        "email": user_email,
        "type": "access" | "refresh",
        "tid": tenant_id (optional),
        "exp": expiry,
        "iat": issued_at,
    }
"""

from __future__ import annotations

import os
import time
import hashlib
import secrets
from typing import Optional

from jose import jwt, JWTError
from passlib.context import CryptContext

# === Config ===

JWT_SECRET = os.getenv("JWT_SECRET", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"

ACCESS_TOKEN_EXPIRE_SECONDS = int(os.getenv("ACCESS_TOKEN_EXPIRE_SECONDS", "1800"))    # 30 min
REFRESH_TOKEN_EXPIRE_SECONDS = int(os.getenv("REFRESH_TOKEN_EXPIRE_SECONDS", "2592000"))  # 30 days

# Password hashing — use bcrypt directly (passlib has compat issues with bcrypt 5.x)
import bcrypt as _bcrypt


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    pw_bytes = password.encode("utf-8")
    # bcrypt has 72-byte limit; truncate if needed
    if len(pw_bytes) > 72:
        pw_bytes = pw_bytes[:72]
    return _bcrypt.hashpw(pw_bytes, _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a password against its bcrypt hash."""
    pw_bytes = plain.encode("utf-8")
    if len(pw_bytes) > 72:
        pw_bytes = pw_bytes[:72]
    try:
        return _bcrypt.checkpw(pw_bytes, hashed.encode("utf-8"))
    except Exception:
        return False


# ========================================================================
# JWT Tokens
# ========================================================================

def create_access_token(
    user_id: str,
    email: Optional[str] = None,
    tenant_id: Optional[str] = None,
    extra_claims: Optional[dict] = None,
) -> str:
    now = time.time()
    payload = {
        "sub": user_id,
        "type": "access",
        "iat": now,
        "exp": now + ACCESS_TOKEN_EXPIRE_SECONDS,
    }
    if email:
        payload["email"] = email
    if tenant_id:
        payload["tid"] = tenant_id
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(
    user_id: str,
    tenant_id: Optional[str] = None,
) -> str:
    now = time.time()
    payload = {
        "sub": user_id,
        "type": "refresh",
        "iat": now,
        "exp": now + REFRESH_TOKEN_EXPIRE_SECONDS,
    }
    if tenant_id:
        payload["tid"] = tenant_id
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    """Decode and verify a JWT token. Returns None on failure."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError:
        return None


def hash_token(token: str) -> str:
    """Hash a refresh token for storage (never store raw tokens)."""
    return hashlib.sha256(token.encode()).hexdigest()


# ========================================================================
# Token Pair Helper
# ========================================================================

def create_token_pair(
    user_id: str,
    email: Optional[str] = None,
    tenant_id: Optional[str] = None,
) -> dict:
    """Create access + refresh token pair."""
    access = create_access_token(user_id, email, tenant_id)
    refresh = create_refresh_token(user_id, tenant_id)
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_SECONDS,
    }
