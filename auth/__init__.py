"""
Data-Agent Authentication & Multi-Tenant System

Modules:
    models   — SQLAlchemy ORM (User, OAuthAccount, Tenant, TenantMember)
    database — Async SQLite engine + session factory
    security — JWT token generation/verification, password hashing
    oauth    — WeChat & GitHub OAuth client
    service  — Auth business logic (register, login, bind, tenant)
    routes   — FastAPI routers (/auth/*, /tenants/*)
    deps     — FastAPI dependency injection (current_user, tenant context)
"""

from .models import User, OAuthAccount, Tenant, TenantMember, AuthProvider
from .security import create_access_token, create_refresh_token, decode_token
from .service import (
    register_by_email, login_by_email, oauth_login,
    create_tenant, add_tenant_member, switch_active_tenant,
    AuthError,
)

__all__ = [
    "User", "OAuthAccount", "Tenant", "TenantMember", "AuthProvider",
    "create_access_token", "create_refresh_token", "decode_token",
    "register_by_email", "login_by_email", "oauth_login",
    "create_tenant", "add_tenant_member", "switch_active_tenant",
    "AuthError",
]
