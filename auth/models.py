"""
Database models for auth & multi-tenant system.

Tables:
    users          — Local account (email + password)
    oauth_accounts — Third-party OAuth bindings (WeChat, GitHub)
    tenants        — Organization/workspace
    tenant_members — User ↔ Tenant membership (role-based)
    user_sessions  — Refresh token tracking (for revocation)
"""

from __future__ import annotations

import enum
import uuid
import time
from typing import Optional

from sqlalchemy import (
    Column, String, Boolean, Integer, Float, Text, ForeignKey,
    Enum as SAEnum, UniqueConstraint, Index, text
)
from sqlalchemy.orm import DeclarativeBase, relationship


class AuthProvider(str, enum.Enum):
    LOCAL = "local"
    WECHAT = "wechat"
    GITHUB = "github"


class MemberRole(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    VIEWER = "viewer"


class Base(DeclarativeBase):
    pass


def _gen_id() -> str:
    return uuid.uuid4().hex


def _now() -> float:
    return time.time()


# ========================================================================
# User
# ========================================================================

class User(Base):
    """Local user account. One email = one account."""

    __tablename__ = "users"

    id = Column(String(32), primary_key=True, default=_gen_id)
    email = Column(String(255), unique=True, nullable=True, index=True)  # nullable for phone-only
    phone = Column(String(32), unique=True, nullable=True, index=True)   # nullable for email-only
    username = Column(String(128), nullable=False, default="user")
    avatar_url = Column(Text, nullable=True)

    # Password (local auth only; null for OAuth-only users who haven't set one)
    password_hash = Column(String(255), nullable=True)

    # Status
    is_active = Column(Boolean, default=True, nullable=False)
    is_verified = Column(Boolean, default=False, nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)  # system admin

    # Tenant context (current active tenant, switchable)
    active_tenant_id = Column(String(32), ForeignKey("tenants.id"), nullable=True)

    # Timestamps
    created_at = Column(Float, default=_now, nullable=False)
    updated_at = Column(Float, default=_now, onupdate=_now, nullable=False)
    last_login_at = Column(Float, nullable=True)

    # Relationships
    oauth_accounts = relationship("OAuthAccount", back_populates="user",
                                  cascade="all, delete-orphan")
    tenant_memberships = relationship(
        "TenantMember", back_populates="user",
        cascade="all, delete-orphan",
        foreign_keys="TenantMember.user_id",
    )
    active_tenant = relationship("Tenant", foreign_keys=[active_tenant_id])

    def __repr__(self):
        return f"<User {self.username} ({self.email or self.phone})>"


# ========================================================================
# OAuth Account
# ========================================================================

class OAuthAccount(Base):
    """Third-party OAuth binding. One user can have multiple bindings."""

    __tablename__ = "oauth_accounts"

    id = Column(String(32), primary_key=True, default=_gen_id)
    user_id = Column(String(32), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)

    provider = Column(SAEnum(AuthProvider), nullable=False)
    provider_user_id = Column(String(255), nullable=False)  # openid / github node_id

    # Profile snapshot from OAuth provider
    provider_username = Column(String(255), nullable=True)
    provider_email = Column(String(255), nullable=True)
    provider_avatar = Column(Text, nullable=True)
    provider_raw = Column(Text, nullable=True)  # JSON dump of full profile

    created_at = Column(Float, default=_now, nullable=False)
    updated_at = Column(Float, default=_now, onupdate=_now, nullable=False)

    # One provider per user (a user can't bind WeChat twice)
    __table_args__ = (
        UniqueConstraint("user_id", "provider", name="uq_user_provider"),
        UniqueConstraint("provider", "provider_user_id", name="uq_provider_uid"),
        Index("ix_oauth_lookup", "provider", "provider_user_id"),
    )

    user = relationship("User", back_populates="oauth_accounts")

    def __repr__(self):
        return f"<OAuth {self.provider.value}:{self.provider_username} → {self.user_id}>"


# ========================================================================
# Tenant (Organization / Workspace)
# ========================================================================

class Tenant(Base):
    """Multi-tenant isolation unit. Each tenant has its own data space."""

    __tablename__ = "tenants"

    id = Column(String(32), primary_key=True, default=_gen_id)
    name = Column(String(128), nullable=False)
    slug = Column(String(64), unique=True, nullable=False, index=True)  # URL-safe identifier

    # Plan / limits
    plan = Column(String(32), default="free", nullable=False)  # free | pro | enterprise
    max_members = Column(Integer, default=10, nullable=False)
    max_queries_per_day = Column(Integer, default=1000, nullable=False)

    # Data isolation
    db_path = Column(Text, nullable=True)  # per-tenant SQLite path (null = shared)

    # Status
    is_active = Column(Boolean, default=True, nullable=False)

    created_at = Column(Float, default=_now, nullable=False)
    updated_at = Column(Float, default=_now, onupdate=_now, nullable=False)

    members = relationship("TenantMember", back_populates="tenant",
                           cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Tenant {self.slug} ({self.name})>"


class TenantMember(Base):
    """User ↔ Tenant membership with role."""

    __tablename__ = "tenant_members"

    id = Column(String(32), primary_key=True, default=_gen_id)
    tenant_id = Column(String(32), ForeignKey("tenants.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    user_id = Column(String(32), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    role = Column(SAEnum(MemberRole), default=MemberRole.MEMBER, nullable=False)

    # Metadata
    invited_by = Column(String(32), ForeignKey("users.id"), nullable=True)
    joined_at = Column(Float, default=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", name="uq_tenant_user"),
    )

    tenant = relationship("Tenant", back_populates="members")
    user = relationship(
        "User", back_populates="tenant_memberships",
        foreign_keys=[user_id],
    )

    @property
    def is_owner(self) -> bool:
        return self.role == MemberRole.OWNER

    @property
    def is_admin_or_above(self) -> bool:
        return self.role in (MemberRole.OWNER, MemberRole.ADMIN)

    def __repr__(self):
        return f"<Member {self.user_id} @ {self.tenant_id} ({self.role.value})>"


# ========================================================================
# User Session (Refresh Token Tracking)
# ========================================================================

class UserSession(Base):
    """Tracks refresh tokens for revocation. One row per login session."""

    __tablename__ = "user_sessions"

    id = Column(String(32), primary_key=True, default=_gen_id)
    user_id = Column(String(32), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    refresh_token_hash = Column(String(255), nullable=False, unique=True)

    # Device / client info
    user_agent = Column(String(512), nullable=True)
    ip_address = Column(String(64), nullable=True)

    is_revoked = Column(Boolean, default=False, nullable=False)
    expires_at = Column(Float, nullable=False)
    created_at = Column(Float, default=_now, nullable=False)

    def __repr__(self):
        return f"<Session {self.user_id} ({'revoked' if self.is_revoked else 'active'})>"
