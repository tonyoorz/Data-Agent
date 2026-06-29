"""
FastAPI auth routes.

Endpoints:
    POST   /auth/register          — Email registration
    POST   /auth/login             — Email login
    POST   /auth/oauth/{provider}  — OAuth login (wechat | github)
    POST   /auth/refresh           — Refresh access token
    POST   /auth/logout            — Revoke current session
    POST   /auth/logout-all        — Revoke all sessions

    GET    /auth/oauth/{provider}/url — Get OAuth authorize URL
    POST   /auth/bind/{provider}       — Bind OAuth to logged-in user
    DELETE /auth/bind/{provider}       — Unbind OAuth

    GET    /auth/me                — Current user profile
    PUT    /auth/me                — Update profile
    GET    /auth/me/bindings       — List OAuth bindings

    POST   /auth/password/forgot   — Request password reset code
    POST   /auth/password/reset    — Reset password with code
    POST   /auth/verify/send       — Send email verification code
    POST   /auth/verify/confirm    — Confirm email verification

    POST   /tenants                — Create tenant
    GET    /tenants                — List my tenants
    POST   /tenants/{id}/switch    — Switch active tenant
    POST   /tenants/{id}/members   — Add member
    DELETE /tenants/{id}/members/{uid} — Remove member
    GET    /tenants/{id}/members   — List members
"""

from __future__ import annotations

from typing import Optional, List
from pydantic import BaseModel, EmailStr, Field
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .database import db_session, init_auth_db
from .models import User, OAuthAccount, Tenant, TenantMember, AuthProvider, MemberRole
from .security import create_token_pair, decode_token
from .service import (
    AuthError,
    register_by_email, login_by_email,
    oauth_login,
    bind_oauth_account, unbind_oauth_account,
    create_session, refresh_access_token,
    revoke_session, revoke_all_sessions,
    create_tenant, add_tenant_member, switch_active_tenant,
    send_verification_code, verify_code_and_reset_password, verify_email,
)
from .oauth import get_auth_url
from .deps import get_current_user, get_current_tenant, require_role

router = APIRouter(prefix="/auth", tags=["auth"])
tenant_router = APIRouter(prefix="/tenants", tags=["tenants"])


# ========================================================================
# Schemas
# ========================================================================

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    username: Optional[str] = Field(default=None, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class OAuthLoginRequest(BaseModel):
    code: str = Field(..., description="Authorization code from OAuth provider")


class OAuthBindRequest(BaseModel):
    code: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class UserProfile(BaseModel):
    id: str
    email: Optional[str]
    phone: Optional[str]
    username: str
    avatar_url: Optional[str]
    is_verified: bool
    active_tenant_id: Optional[str]
    created_at: float

    class Config:
        from_attributes = True


class UpdateProfileRequest(BaseModel):
    username: Optional[str] = None
    avatar_url: Optional[str] = None
    password: Optional[str] = Field(default=None, min_length=6)


class OAuthBindingInfo(BaseModel):
    provider: str
    provider_username: Optional[str]
    provider_avatar: Optional[str]
    bound_at: float

    class Config:
        from_attributes = True


class CreateTenantRequest(BaseModel):
    name: str = Field(max_length=128)
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$", max_length=64)
    plan: str = "free"


class AddMemberRequest(BaseModel):
    user_id: str
    role: str = "member"  # viewer | member | admin | owner


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6)
    new_password: str = Field(..., min_length=6, max_length=128)


class SendVerificationRequest(BaseModel):
    email: EmailStr


class ConfirmVerificationRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=6)


class MemberInfo(BaseModel):
    user_id: str
    username: str
    role: str
    joined_at: float


class TenantInfo(BaseModel):
    id: str
    name: str
    slug: str
    plan: str
    member_count: int

    class Config:
        from_attributes = True


# ========================================================================
# Helper
# ========================================================================

def _handle_auth_error(e: AuthError):
    raise HTTPException(status_code=e.status, detail={"code": e.code, "message": e.message})


def _extract_request_info(request: Request):
    return {
        "user_agent": request.headers.get("user-agent"),
        "ip_address": request.client.host if request.client else None,
    }


# ========================================================================
# Auth Routes
# ========================================================================

# NOTE: auth DB init is handled in main app startup, not here
# (sub-router on_event doesn't fire)


@router.post("/register", response_model=TokenResponse)
async def register(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(db_session),
):
    """Register with email + password."""
    try:
        user = await register_by_email(db, body.email, body.password, body.username)
    except AuthError as e:
        _handle_auth_error(e)

    tokens = create_token_pair(user.id, user.email, user.active_tenant_id)
    info = _extract_request_info(request)
    await create_session(db, user.id, tokens["refresh_token"], **info)
    await db.commit()
    return TokenResponse(**tokens)


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(db_session),
):
    """Login with email + password."""
    try:
        user = await login_by_email(db, body.email, body.password)
    except AuthError as e:
        _handle_auth_error(e)

    tokens = create_token_pair(user.id, user.email, user.active_tenant_id)
    info = _extract_request_info(request)
    await create_session(db, user.id, tokens["refresh_token"], **info)
    await db.commit()
    return TokenResponse(**tokens)


@router.get("/oauth/{provider}/url")
async def oauth_url(provider: str):
    """Get OAuth authorize URL for redirect."""
    import secrets
    state = secrets.token_urlsafe(16)
    try:
        url = get_auth_url(provider, state)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"url": url, "state": state}


@router.post("/oauth/{provider}", response_model=TokenResponse)
async def oauth_login_route(
    provider: str,
    body: OAuthLoginRequest,
    request: Request,
    db: AsyncSession = Depends(db_session),
):
    """Login or register via OAuth (WeChat / GitHub)."""
    try:
        user, is_new = await oauth_login(db, provider, body.code)
    except AuthError as e:
        _handle_auth_error(e)
    except ValueError as e:
        raise HTTPException(400, str(e))

    tokens = create_token_pair(user.id, user.email, user.active_tenant_id)
    info = _extract_request_info(request)
    await create_session(db, user.id, tokens["refresh_token"], **info)
    await db.commit()

    response = TokenResponse(**tokens)
    # Frontend can check is_new to show onboarding
    return response


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    body: RefreshRequest,
    db: AsyncSession = Depends(db_session),
):
    """Exchange refresh token for new token pair."""
    try:
        tokens = await refresh_access_token(db, body.refresh_token)
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()
    return TokenResponse(**tokens)


@router.post("/logout")
async def logout(
    body: RefreshRequest,
    db: AsyncSession = Depends(db_session),
):
    """Revoke current refresh token."""
    await revoke_session(db, body.refresh_token)
    await db.commit()
    return {"message": "已退出登录"}


@router.post("/logout-all")
async def logout_all(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    """Revoke all sessions (logout everywhere)."""
    count = await revoke_all_sessions(db, user.id)
    await db.commit()
    return {"message": f"已注销 {count} 个会话"}


# ========================================================================
# Profile Routes
# ========================================================================

@router.get("/me", response_model=UserProfile)
async def get_me(user: User = Depends(get_current_user)):
    return user


@router.put("/me", response_model=UserProfile)
async def update_me(
    body: UpdateProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    if body.username:
        user.username = body.username
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url
    if body.password:
        from .security import hash_password
        user.password_hash = hash_password(body.password)
    await db.commit()
    return user


@router.get("/me/bindings", response_model=List[OAuthBindingInfo])
async def list_bindings(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    result = await db.execute(
        select(OAuthAccount).where(OAuthAccount.user_id == user.id)
    )
    return result.scalars().all()


@router.post("/bind/{provider}")
async def bind_oauth(
    provider: str,
    body: OAuthBindRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    """Bind a new OAuth provider to current user."""
    try:
        acct = await bind_oauth_account(db, user.id, provider, body.code)
    except AuthError as e:
        _handle_auth_error(e)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await db.commit()
    return {"message": f"已绑定 {provider}", "provider_username": acct.provider_username}


@router.delete("/bind/{provider}")
async def unbind_oauth(
    provider: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    """Unbind an OAuth provider from current user."""
    try:
        await unbind_oauth_account(db, user.id, provider)
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()
    return {"message": f"已解绑 {provider}"}


# ========================================================================
# Password Reset & Email Verification Routes
# ========================================================================

@router.post("/password/forgot")
async def forgot_password(
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(db_session),
):
    """Request a password reset verification code (sent via email)."""
    try:
        code = await send_verification_code(db, body.email, purpose="reset")
    except AuthError as e:
        # Don't reveal whether email exists (security)
        if e.code == "email_not_found":
            return {"message": "如果该邮箱已注册，验证码已发送"}
        _handle_auth_error(e)
    await db.commit()
    # Dev mode: return code directly. Production: send email, don't return code.
    if os.getenv("AUTH_DEV_MODE", "1") == "1":
        return {"message": "验证码已生成", "dev_code": code}
    return {"message": "如果该邮箱已注册，验证码已发送"}


@router.post("/password/reset")
async def reset_password(
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(db_session),
):
    """Reset password with verification code."""
    try:
        user = await verify_code_and_reset_password(db, body.email, body.code, body.new_password)
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()
    return {"message": "密码已重置，请重新登录"}


@router.post("/verify/send")
async def send_verification(
    body: SendVerificationRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    """Send email verification code to current user's email."""
    if not user.email:
        raise HTTPException(400, "当前账号未绑定邮箱")
    try:
        code = await send_verification_code(db, user.email, purpose="verify")
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()
    if os.getenv("AUTH_DEV_MODE", "1") == "1":
        return {"message": "验证码已发送", "dev_code": code}
    return {"message": "验证码已发送至您的邮箱"}


@router.post("/verify/confirm")
async def confirm_verification(
    body: ConfirmVerificationRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    """Confirm email verification with code."""
    try:
        user = await verify_email(db, user.id, body.code)
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()
    return {"message": "邮箱验证成功", "is_verified": user.is_verified}


# ========================================================================
# Tenant Routes
# ========================================================================

@tenant_router.post("", response_model=TenantInfo)
async def create_new_tenant(
    body: CreateTenantRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    try:
        tenant = await create_tenant(db, body.name, body.slug, user.id, body.plan)
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()
    return TenantInfo(
        id=tenant.id, name=tenant.name, slug=tenant.slug,
        plan=tenant.plan, member_count=1,
    )


@tenant_router.get("", response_model=List[TenantInfo])
async def list_my_tenants(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    result = await db.execute(
        select(TenantMember).where(TenantMember.user_id == user.id)
    )
    memberships = result.scalars().all()

    tenants_info = []
    for m in memberships:
        tenant = await db.get(Tenant, m.tenant_id)
        if tenant and tenant.is_active:
            # Count members
            count_result = await db.execute(
                select(TenantMember).where(TenantMember.tenant_id == tenant.id)
            )
            count = len(count_result.scalars().all())
            tenants_info.append(TenantInfo(
                id=tenant.id, name=tenant.name, slug=tenant.slug,
                plan=tenant.plan, member_count=count,
            ))
    return tenants_info


@tenant_router.post("/{tenant_id}/switch")
async def switch_tenant(
    tenant_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    try:
        user = await switch_active_tenant(db, user.id, tenant_id)
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()

    # Return new token pair with updated tenant context
    tokens = create_token_pair(user.id, user.email, user.active_tenant_id)
    return {"message": "已切换租户", **tokens}


@tenant_router.get("/{tenant_id}/members", response_model=List[MemberInfo])
async def list_tenant_members(
    tenant_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    # Verify access
    result = await db.execute(
        select(TenantMember).where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id == user.id,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(403, "无权访问")

    result = await db.execute(
        select(TenantMember, User).join(User, TenantMember.user_id == User.id)
        .where(TenantMember.tenant_id == tenant_id)
    )
    members = []
    for member, u in result.all():
        members.append(MemberInfo(
            user_id=u.id, username=u.username,
            role=member.role.value, joined_at=member.joined_at,
        ))
    return members


@tenant_router.post("/{tenant_id}/members", status_code=201)
async def add_member(
    tenant_id: str,
    body: AddMemberRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    # Require admin or owner
    result = await db.execute(
        select(TenantMember).where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id == user.id,
        )
    )
    my_membership = result.scalar_one_or_none()
    if not my_membership or not my_membership.is_admin_or_above:
        raise HTTPException(403, "需要管理员权限")

    try:
        role = MemberRole(body.role)
    except ValueError:
        raise HTTPException(400, f"无效角色: {body.role}")

    try:
        member = await add_tenant_member(db, tenant_id, body.user_id, role, invited_by=user.id)
    except AuthError as e:
        _handle_auth_error(e)
    await db.commit()
    return {"message": "成员已添加", "role": role.value}


@tenant_router.delete("/{tenant_id}/members/{target_user_id}")
async def remove_member(
    tenant_id: str,
    target_user_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(db_session),
):
    # Check permission
    result = await db.execute(
        select(TenantMember).where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id == user.id,
        )
    )
    my_membership = result.scalar_one_or_none()
    if not my_membership or not my_membership.is_admin_or_above:
        raise HTTPException(403, "需要管理员权限")

    # Can't remove owner
    result = await db.execute(
        select(TenantMember).where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id == target_user_id,
        )
    )
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(404, "成员不存在")
    if target.role == MemberRole.OWNER:
        raise HTTPException(400, "不能移除所有者")

    await db.delete(target)
    await db.commit()
    return {"message": "成员已移除"}
