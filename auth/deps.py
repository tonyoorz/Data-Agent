"""
FastAPI dependency injection for auth.

Usage in routes:
    @router.get("/me")
    async def me(user: User = Depends(get_current_user)):
        return user
"""

from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from .models import User, Tenant
from .security import decode_token
from .database import db_session

# Bearer token scheme
bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: AsyncSession = Depends(db_session),
) -> User:
    """Extract and verify the JWT bearer token, return the User."""
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="未提供认证令牌")

    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="无效或过期的令牌")

    user_id = payload.get("sub")
    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="用户不存在或已禁用")

    return user


async def get_current_user_optional(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: AsyncSession = Depends(db_session),
) -> Optional[User]:
    """Like get_current_user but returns None instead of raising (for public endpoints)."""
    if not credentials:
        return None
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access":
        return None
    user_id = payload.get("sub")
    user = await db.get(User, user_id)
    if not user or not user.is_active:
        return None
    return user


async def get_current_tenant(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
) -> Optional[Tenant]:
    """Get the user's current active tenant."""
    if not user.active_tenant_id:
        return None
    tenant = await db.get(Tenant, user.active_tenant_id)
    if not tenant or not tenant.is_active:
        return None
    return tenant


def require_role(min_role: str):
    """
    Dependency factory: require the user to have at least `min_role`
    in their active tenant.

    Usage:
        @router.delete("/tenants/{id}/members/{uid}")
        async def remove_member(
            ...,
            _=Depends(require_role("admin")),
        ):
    """
    from .models import MemberRole

    role_order = {
        "viewer": 0,
        "member": 1,
        "admin": 2,
        "owner": 3,
    }
    required_level = role_order.get(min_role, 1)

    async def _check(
        user: User = Depends(get_current_user),
        tenant: Optional[Tenant] = Depends(get_current_tenant),
        db: AsyncSession = Depends(db_session),
    ):
        if not tenant:
            raise HTTPException(403, "无活跃租户")
        from sqlalchemy import select
        from .models import TenantMember

        result = await db.execute(
            select(TenantMember).where(
                TenantMember.tenant_id == tenant.id,
                TenantMember.user_id == user.id,
            )
        )
        member = result.scalar_one_or_none()
        if not member:
            raise HTTPException(403, "非租户成员")

        user_level = role_order.get(member.role.value, 0)
        if user_level < required_level:
            raise HTTPException(403, f"需要 {min_role} 及以上权限")

        return member

    return _check
