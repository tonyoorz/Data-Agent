"""
Auth service layer — business logic for:
    - Email/password registration & login
    - OAuth login (WeChat, GitHub)
    - OAuth account binding/unbinding
    - Tenant management
    - Token refresh & session management
"""

from __future__ import annotations

import logging
import secrets
import time
from typing import Optional
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    User, OAuthAccount, Tenant, TenantMember, UserSession,
    AuthProvider, MemberRole,
)
from .security import (
    hash_password, verify_password,
    create_token_pair, decode_token, hash_token,
)
from .oauth import get_oauth_user_info, OAuthUserInfo

logger = logging.getLogger("auth.service")


class AuthError(Exception):
    """Base auth error."""
    def __init__(self, message: str, code: str = "auth_error", status: int = 400):
        self.message = message
        self.code = code
        self.status = status
        super().__init__(message)


# ========================================================================
# Registration & Login (Email/Password)
# ========================================================================

async def register_by_email(
    db: AsyncSession,
    email: str,
    password: str,
    username: Optional[str] = None,
) -> User:
    """Register a new user with email + password."""
    # Check email uniqueness
    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none():
        raise AuthError("该邮箱已注册", "email_taken", 409)

    user = User(
        email=email,
        username=username or email.split("@")[0],
        password_hash=hash_password(password),
        is_verified=False,
    )
    db.add(user)
    await db.flush()
    return user


async def login_by_email(
    db: AsyncSession,
    email: str,
    password: str,
) -> User:
    """Login with email + password."""
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if not user or not user.password_hash:
        raise AuthError("邮箱或密码错误", "invalid_credentials", 401)
    if not verify_password(password, user.password_hash):
        raise AuthError("邮箱或密码错误", "invalid_credentials", 401)
    if not user.is_active:
        raise AuthError("账号已被禁用", "account_disabled", 403)

    user.last_login_at = datetime.now().timestamp()
    await db.flush()
    return user


# ========================================================================
# OAuth Login
# ========================================================================

async def oauth_login(
    db: AsyncSession,
    provider: str,
    code: str,
) -> tuple[User, bool]:
    """
    OAuth login flow.
    Returns (user, is_new_user).
    If provider account not bound, creates a new user automatically.
    """
    oauth_info = await get_oauth_user_info(provider, code)

    # Check if this OAuth account already exists
    result = await db.execute(
        select(OAuthAccount).where(
            OAuthAccount.provider == AuthProvider(provider),
            OAuthAccount.provider_user_id == oauth_info.provider_user_id,
        )
    )
    oauth_acct = result.scalar_one_or_none()

    if oauth_acct:
        # Existing binding → get user
        result = await db.execute(select(User).where(User.id == oauth_acct.user_id))
        user = result.scalar_one()
        if not user.is_active:
            raise AuthError("账号已被禁用", "account_disabled", 403)

        # Update profile from OAuth if changed
        _update_oauth_profile(oauth_acct, oauth_info)
        user.last_login_at = datetime.now().timestamp()
        await db.flush()
        return user, False

    # No existing binding — try to match by email
    if oauth_info.email:
        result = await db.execute(select(User).where(User.email == oauth_info.email))
        existing_user = result.scalar_one_or_none()
        if existing_user:
            # Auto-bind OAuth to existing email account
            _create_oauth_binding(db, existing_user.id, oauth_info)
            existing_user.last_login_at = datetime.now().timestamp()
            await db.flush()
            return existing_user, False

    # Brand new user — create account + binding
    user = User(
        email=oauth_info.email,
        username=oauth_info.username,
        avatar_url=oauth_info.avatar_url,
        is_verified=True,  # OAuth providers verify email
    )
    db.add(user)
    await db.flush()

    _create_oauth_binding(db, user.id, oauth_info)
    user.last_login_at = datetime.now().timestamp()
    await db.flush()

    logger.info(f"New user via OAuth {provider}: {user.id} ({user.username})")
    return user, True


def _create_oauth_binding(db: AsyncSession, user_id: str, info: OAuthUserInfo):
    import json
    acct = OAuthAccount(
        user_id=user_id,
        provider=AuthProvider(info.provider),
        provider_user_id=info.provider_user_id,
        provider_username=info.username,
        provider_email=info.email,
        provider_avatar=info.avatar_url,
        provider_raw=json.dumps(info.raw, ensure_ascii=False),
    )
    db.add(acct)


def _update_oauth_profile(acct: OAuthAccount, info: OAuthUserInfo):
    if info.username and info.username != acct.provider_username:
        acct.provider_username = info.username
    if info.avatar_url and info.avatar_url != acct.provider_avatar:
        acct.provider_avatar = info.avatar_url


# ========================================================================
# OAuth Binding Management
# ========================================================================

async def bind_oauth_account(
    db: AsyncSession,
    user_id: str,
    provider: str,
    code: str,
) -> OAuthAccount:
    """Bind a new OAuth account to an existing user."""
    # Check if user already has this provider bound
    result = await db.execute(
        select(OAuthAccount).where(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == AuthProvider(provider),
        )
    )
    if result.scalar_one_or_none():
        raise AuthError(f"已绑定{provider}账号", "already_bound", 409)

    oauth_info = await get_oauth_user_info(provider, code)

    # Check if this OAuth account is bound to someone else
    result = await db.execute(
        select(OAuthAccount).where(
            OAuthAccount.provider == AuthProvider(provider),
            OAuthAccount.provider_user_id == oauth_info.provider_user_id,
        )
    )
    if result.scalar_one_or_none():
        raise AuthError(f"该{provider}账号已被其他用户绑定", "oauth_taken", 409)

    import json
    acct = OAuthAccount(
        user_id=user_id,
        provider=AuthProvider(provider),
        provider_user_id=oauth_info.provider_user_id,
        provider_username=oauth_info.username,
        provider_email=oauth_info.email,
        provider_avatar=oauth_info.avatar_url,
        provider_raw=json.dumps(oauth_info.raw, ensure_ascii=False),
    )
    db.add(acct)
    await db.flush()
    return acct


async def unbind_oauth_account(
    db: AsyncSession,
    user_id: str,
    provider: str,
) -> None:
    """Unbind an OAuth account from user."""
    result = await db.execute(
        select(OAuthAccount).where(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == AuthProvider(provider),
        )
    )
    acct = result.scalar_one_or_none()
    if not acct:
        raise AuthError(f"未绑定{provider}账号", "not_bound", 404)

    # Safety check: user must have at least one login method
    result = await db.execute(
        select(OAuthAccount).where(OAuthAccount.user_id == user_id)
    )
    all_bindings = result.scalars().all()

    user = await db.get(User, user_id)
    has_password = user and user.password_hash

    if len(all_bindings) <= 1 and not has_password:
        raise AuthError("无法解绑最后一个登录方式", "last_login_method", 400)

    await db.delete(acct)
    await db.flush()


# ========================================================================
# Session & Token Management
# ========================================================================

async def create_session(
    db: AsyncSession,
    user_id: str,
    refresh_token: str,
    user_agent: Optional[str] = None,
    ip_address: Optional[str] = None,
) -> UserSession:
    """Record refresh token in DB for tracking/revocation."""
    import time
    session = UserSession(
        user_id=user_id,
        refresh_token_hash=hash_token(refresh_token),
        user_agent=user_agent,
        ip_address=ip_address,
        expires_at=time.time() + 30 * 86400,
    )
    db.add(session)
    await db.flush()
    return session


async def refresh_access_token(
    db: AsyncSession,
    refresh_token: str,
) -> dict:
    """Exchange refresh token for new access token."""
    payload = decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise AuthError("无效的刷新令牌", "invalid_refresh", 401)

    token_hash = hash_token(refresh_token)
    result = await db.execute(
        select(UserSession).where(UserSession.refresh_token_hash == token_hash)
    )
    session = result.scalar_one_or_none()

    if not session or session.is_revoked:
        raise AuthError("刷新令牌已失效", "refresh_revoked", 401)

    import time
    if session.expires_at < time.time():
        raise AuthError("刷新令牌已过期", "refresh_expired", 401)

    user = await db.get(User, session.user_id)
    if not user or not user.is_active:
        raise AuthError("账号不可用", "account_disabled", 403)

    return create_token_pair(
        user_id=user.id,
        email=user.email,
        tenant_id=user.active_tenant_id,
    )


async def revoke_session(
    db: AsyncSession,
    refresh_token: str,
) -> None:
    """Revoke a refresh token session."""
    token_hash = hash_token(refresh_token)
    result = await db.execute(
        select(UserSession).where(UserSession.refresh_token_hash == token_hash)
    )
    session = result.scalar_one_or_none()
    if session:
        session.is_revoked = True
        await db.flush()


async def revoke_all_sessions(
    db: AsyncSession,
    user_id: str,
) -> int:
    """Revoke all sessions for a user (logout everywhere)."""
    result = await db.execute(
        select(UserSession).where(
            UserSession.user_id == user_id,
            UserSession.is_revoked == False,
        )
    )
    sessions = result.scalars().all()
    for s in sessions:
        s.is_revoked = True
    await db.flush()
    return len(sessions)


# ========================================================================
# Tenant Management
# ========================================================================

async def create_tenant(
    db: AsyncSession,
    name: str,
    slug: str,
    owner_id: str,
    plan: str = "free",
) -> Tenant:
    """Create a new tenant with the creator as owner."""
    # Check slug uniqueness
    result = await db.execute(select(Tenant).where(Tenant.slug == slug))
    if result.scalar_one_or_none():
        raise AuthError("该标识已被使用", "slug_taken", 409)

    tenant = Tenant(name=name, slug=slug, plan=plan)
    db.add(tenant)
    await db.flush()

    # Add owner as first member
    member = TenantMember(
        tenant_id=tenant.id,
        user_id=owner_id,
        role=MemberRole.OWNER,
    )
    db.add(member)

    # Set as active tenant if user has none
    user = await db.get(User, owner_id)
    if user and not user.active_tenant_id:
        user.active_tenant_id = tenant.id

    await db.flush()
    return tenant


async def add_tenant_member(
    db: AsyncSession,
    tenant_id: str,
    user_id: str,
    role: MemberRole = MemberRole.MEMBER,
    invited_by: Optional[str] = None,
) -> TenantMember:
    """Add a member to a tenant."""
    # Check if already member
    result = await db.execute(
        select(TenantMember).where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id == user_id,
        )
    )
    if result.scalar_one_or_none():
        raise AuthError("该用户已是成员", "already_member", 409)

    member = TenantMember(
        tenant_id=tenant_id,
        user_id=user_id,
        role=role,
        invited_by=invited_by,
    )
    db.add(member)
    await db.flush()
    return member


async def switch_active_tenant(
    db: AsyncSession,
    user_id: str,
    tenant_id: str,
) -> User:
    """Switch user's active tenant context."""
    # Verify membership
    result = await db.execute(
        select(TenantMember).where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id == user_id,
        )
    )
    if not result.scalar_one_or_none():
        raise AuthError("无权访问该租户", "not_member", 403)

    user = await db.get(User, user_id)
    user.active_tenant_id = tenant_id
    await db.flush()
    return user


# ========================================================================
# Password Reset & Email Verification
# ========================================================================

# In-memory verification code store (production: use Redis with TTL)
_verification_codes: dict[str, tuple[str, float]] = {}
_VERIFICATION_CODE_TTL = 600  # 10 minutes


def _generate_code() -> str:
    """Generate a 6-digit verification code."""
    import random
    return f"{random.randint(100000, 999999)}"


async def send_verification_code(
    db: AsyncSession,
    email: str,
    purpose: str = "reset",  # reset | verify
) -> str:
    """
    Generate a verification code for email reset/verification.
    Returns the code (for dev/testing — in production this goes via email).
    """
    # Check user exists
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user:
        raise AuthError("该邮箱未注册", "email_not_found", 404)

    code = _generate_code()
    key = f"{purpose}:{email}"
    _verification_codes[key] = (code, time.time())

    # TODO: Send email via SMTP / SendGrid / etc.
    # For now, return code so caller can display/log it (dev mode)
    logger.info(f"Verification code for {email} ({purpose}): {code}")
    return code


async def verify_code_and_reset_password(
    db: AsyncSession,
    email: str,
    code: str,
    new_password: str,
) -> User:
    """Verify the reset code and set a new password."""
    key = f"reset:{email}"
    stored = _verification_codes.get(key)

    if not stored:
        raise AuthError("请先获取验证码", "code_not_sent", 400)

    stored_code, created_at = stored
    import time
    if time.time() - created_at > _VERIFICATION_CODE_TTL:
        del _verification_codes[key]
        raise AuthError("验证码已过期，请重新获取", "code_expired", 400)

    if stored_code != code:
        raise AuthError("验证码错误", "code_invalid", 400)

    # Success — reset password
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user:
        raise AuthError("用户不存在", "user_not_found", 404)

    user.password_hash = hash_password(new_password)
    user.is_verified = True
    await db.flush()

    # Clean up code
    del _verification_codes[key]

    # Revoke all sessions (force re-login everywhere)
    await revoke_all_sessions(db, user.id)

    logger.info(f"Password reset for user {user.id} ({email})")
    return user


async def verify_email(
    db: AsyncSession,
    user_id: str,
    code: str,
) -> User:
    """Verify a user's email with a verification code."""
    user = await db.get(User, user_id)
    if not user:
        raise AuthError("用户不存在", "user_not_found", 404)
    if not user.email:
        raise AuthError("用户未设置邮箱", "no_email", 400)

    key = f"verify:{user.email}"
    stored = _verification_codes.get(key)

    if not stored:
        raise AuthError("请先获取验证码", "code_not_sent", 400)

    stored_code, created_at = stored
    import time
    if time.time() - created_at > _VERIFICATION_CODE_TTL:
        del _verification_codes[key]
        raise AuthError("验证码已过期", "code_expired", 400)

    if stored_code != code:
        raise AuthError("验证码错误", "code_invalid", 400)

    user.is_verified = True
    await db.flush()
    del _verification_codes[key]
    logger.info(f"Email verified for user {user.id} ({user.email})")
    return user
