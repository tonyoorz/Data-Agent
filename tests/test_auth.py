"""
Auth system tests.
Tests cover: registration, login, OAuth flow (mocked), tenant management,
token refresh, and account binding.
"""

import asyncio
import pytest
import pytest_asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Ensure project root is importable
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from auth.models import (
    User, OAuthAccount, Tenant, TenantMember, UserSession,
    AuthProvider, MemberRole, Base,
)
from auth.security import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token,
    create_token_pair, hash_token,
)
from auth.database import get_auth_engine, get_session_factory, init_auth_db, db_session
from auth.service import (
    register_by_email, login_by_email,
    create_tenant, add_tenant_member, switch_active_tenant,
    AuthError,
)
from auth.oauth import OAuthUserInfo


# ========================================================================
# Security Tests
# ========================================================================

class TestPasswordHashing:
    def test_hash_and_verify(self):
        password = "MySecurePass123!"
        hashed = hash_password(password)
        assert hashed != password
        assert verify_password(password, hashed)

    def test_wrong_password(self):
        hashed = hash_password("correct")
        assert not verify_password("wrong", hashed)

    def test_different_hashes(self):
        h1 = hash_password("same")
        h2 = hash_password("same")
        assert h1 != h2  # bcrypt uses random salt


class TestJWWTokens:
    def test_access_token(self):
        token = create_access_token("user123", "test@example.com")
        payload = decode_token(token)
        assert payload is not None
        assert payload["sub"] == "user123"
        assert payload["email"] == "test@example.com"
        assert payload["type"] == "access"

    def test_refresh_token(self):
        token = create_refresh_token("user123", "tenant456")
        payload = decode_token(token)
        assert payload is not None
        assert payload["sub"] == "user123"
        assert payload["type"] == "refresh"
        assert payload["tid"] == "tenant456"

    def test_invalid_token(self):
        assert decode_token("invalid.token.here") is None
        assert decode_token("") is None

    def test_token_pair(self):
        pair = create_token_pair("u1", "u1@test.com", "t1")
        assert "access_token" in pair
        assert "refresh_token" in pair
        assert pair["token_type"] == "bearer"
        assert pair["expires_in"] > 0

        access_payload = decode_token(pair["access_token"])
        refresh_payload = decode_token(pair["refresh_token"])
        assert access_payload["type"] == "access"
        assert refresh_payload["type"] == "refresh"
        assert access_payload["sub"] == "u1"
        assert refresh_payload["sub"] == "u1"

    def test_token_hash(self):
        token = "some-random-token"
        h1 = hash_token(token)
        h2 = hash_token(token)
        assert h1 == h2  # deterministic
        assert h1 != token  # not plaintext


# ========================================================================
# Database Tests (integration with SQLite)
# ========================================================================

class TestDatabase:
    @pytest_asyncio.fixture
    async def db(self):
        """Create in-memory DB for testing."""
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

        engine = create_async_engine("sqlite+aiosqlite://", echo=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

        async with factory() as session:
            yield session
            await session.rollback()

        await engine.dispose()

    @pytest.mark.asyncio
    async def test_register_user(self, db):
        user = User(
            email="test@example.com",
            username="testuser",
            password_hash=hash_password("password123"),
        )
        db.add(user)
        await db.flush()

        # Query back
        from sqlalchemy import select
        result = await db.execute(select(User).where(User.email == "test@example.com"))
        fetched = result.scalar_one()
        assert fetched.username == "testuser"
        assert fetched.email == "test@example.com"

    @pytest.mark.asyncio
    async def test_oauth_account_relation(self, db):
        user = User(email="oauth@test.com", username="oauth_user")
        db.add(user)
        await db.flush()

        oauth = OAuthAccount(
            user_id=user.id,
            provider=AuthProvider.GITHUB,
            provider_user_id="github-12345",
            provider_username="githubuser",
            provider_email="github@test.com",
        )
        db.add(oauth)
        await db.flush()

        # Query
        from sqlalchemy import select
        result = await db.execute(
            select(OAuthAccount).where(OAuthAccount.user_id == user.id)
        )
        bindings = result.scalars().all()
        assert len(bindings) == 1
        assert bindings[0].provider == AuthProvider.GITHUB

    @pytest.mark.asyncio
    async def test_tenant_with_members(self, db):
        # Create tenant
        tenant = Tenant(name="Acme Corp", slug="acme")
        db.add(tenant)
        await db.flush()

        # Create users
        owner = User(email="owner@acme.com", username="owner")
        member = User(email="member@acme.com", username="member")
        db.add_all([owner, member])
        await db.flush()

        # Add memberships
        owner_membership = TenantMember(
            tenant_id=tenant.id, user_id=owner.id, role=MemberRole.OWNER
        )
        member_membership = TenantMember(
            tenant_id=tenant.id, user_id=member.id, role=MemberRole.MEMBER
        )
        db.add_all([owner_membership, member_membership])
        await db.flush()

        # Query memberships
        from sqlalchemy import select
        result = await db.execute(
            select(TenantMember).where(TenantMember.tenant_id == tenant.id)
        )
        members = result.scalars().all()
        assert len(members) == 2
        roles = {m.role for m in members}
        assert MemberRole.OWNER in roles
        assert MemberRole.MEMBER in roles

    @pytest.mark.asyncio
    async def test_unique_email_constraint(self, db):
        user1 = User(email="dup@test.com", username="user1")
        db.add(user1)
        await db.flush()

        user2 = User(email="dup@test.com", username="user2")
        db.add(user2)
        with pytest.raises(Exception):  # IntegrityError
            await db.flush()

    @pytest.mark.asyncio
    async def test_unique_oauth_binding(self, db):
        user = User(email="test@test.com", username="test")
        db.add(user)
        await db.flush()

        binding1 = OAuthAccount(
            user_id=user.id, provider=AuthProvider.WECHAT,
            provider_user_id="wx-001",
        )
        db.add(binding1)
        await db.flush()

        # Same provider again for same user should fail
        binding2 = OAuthAccount(
            user_id=user.id, provider=AuthProvider.WECHAT,
            provider_user_id="wx-002",
        )
        db.add(binding2)
        with pytest.raises(Exception):
            await db.flush()


# ========================================================================
# Service Layer Tests (with mocked DB)
# ========================================================================

class TestAuthService:
    @pytest_asyncio.fixture
    async def db(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

        engine = create_async_engine("sqlite+aiosqlite://", echo=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

        async with factory() as session:
            yield session

        await engine.dispose()

    @pytest.mark.asyncio
    async def test_register_by_email(self, db):
        user = await register_by_email(db, "new@test.com", "pass123", "newuser")
        assert user.email == "new@test.com"
        assert user.username == "newuser"
        assert user.password_hash is not None
        assert verify_password("pass123", user.password_hash)

    @pytest.mark.asyncio
    async def test_register_duplicate_email(self, db):
        await register_by_email(db, "dup@test.com", "pass123")
        with pytest.raises(AuthError) as exc:
            await register_by_email(db, "dup@test.com", "pass456")
        assert exc.value.code == "email_taken"

    @pytest.mark.asyncio
    async def test_login_success(self, db):
        await register_by_email(db, "login@test.com", "mypassword", "loginuser")
        user = await login_by_email(db, "login@test.com", "mypassword")
        assert user.email == "login@test.com"
        assert user.last_login_at is not None

    @pytest.mark.asyncio
    async def test_login_wrong_password(self, db):
        await register_by_email(db, "wrong@test.com", "correct")
        with pytest.raises(AuthError) as exc:
            await login_by_email(db, "wrong@test.com", "incorrect")
        assert exc.value.code == "invalid_credentials"

    @pytest.mark.asyncio
    async def test_login_nonexistent(self, db):
        with pytest.raises(AuthError) as exc:
            await login_by_email(db, "nope@test.com", "whatever")
        assert exc.value.code == "invalid_credentials"

    @pytest.mark.asyncio
    async def test_create_tenant(self, db):
        user = await register_by_email(db, "owner@test.com", "pass123", "owner")
        tenant = await create_tenant(db, "My Corp", "my-corp", user.id)
        assert tenant.name == "My Corp"
        assert tenant.slug == "my-corp"

        # Owner should be auto-added as member
        from sqlalchemy import select
        result = await db.execute(
            select(TenantMember).where(
                TenantMember.tenant_id == tenant.id,
                TenantMember.user_id == user.id,
            )
        )
        membership = result.scalar_one()
        assert membership.role == MemberRole.OWNER

        # Active tenant should be set
        await db.refresh(user)
        assert user.active_tenant_id == tenant.id

    @pytest.mark.asyncio
    async def test_duplicate_slug(self, db):
        user = await register_by_email(db, "t@test.com", "pass", "t")
        await create_tenant(db, "First", "my-slug", user.id)
        with pytest.raises(AuthError) as exc:
            await create_tenant(db, "Second", "my-slug", user.id)
        assert exc.value.code == "slug_taken"

    @pytest.mark.asyncio
    async def test_add_tenant_member(self, db):
        owner = await register_by_email(db, "o@test.com", "p", "o")
        member = await register_by_email(db, "m@test.com", "p", "m")
        tenant = await create_tenant(db, "T", "t1", owner.id)

        result = await add_tenant_member(db, tenant.id, member.id, MemberRole.ADMIN)
        assert result.role == MemberRole.ADMIN

    @pytest.mark.asyncio
    async def test_add_duplicate_member(self, db):
        owner = await register_by_email(db, "o@test.com", "p", "o")
        member = await register_by_email(db, "m@test.com", "p", "m")
        tenant = await create_tenant(db, "T", "t2", owner.id)

        await add_tenant_member(db, tenant.id, member.id)
        with pytest.raises(AuthError) as exc:
            await add_tenant_member(db, tenant.id, member.id)
        assert exc.value.code == "already_member"

    @pytest.mark.asyncio
    async def test_switch_tenant(self, db):
        user = await register_by_email(db, "s@test.com", "p", "s")
        t1 = await create_tenant(db, "T1", "s1", user.id)
        t2 = await create_tenant(db, "T2", "s2", user.id)

        # Switch to t2
        user = await switch_active_tenant(db, user.id, t2.id)
        assert user.active_tenant_id == t2.id

    @pytest.mark.asyncio
    async def test_switch_non_member(self, db):
        owner = await register_by_email(db, "o@test.com", "p", "o")
        outsider = await register_by_email(db, "x@test.com", "p", "x")
        tenant = await create_tenant(db, "T", "s3", owner.id)

        with pytest.raises(AuthError) as exc:
            await switch_active_tenant(db, outsider.id, tenant.id)
        assert exc.value.code == "not_member"


# ========================================================================
# OAuth Tests (mocked external calls)
# ========================================================================

class TestOAuthFlow:
    @pytest_asyncio.fixture
    async def db(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

        engine = create_async_engine("sqlite+aiosqlite://", echo=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

        async with factory() as session:
            yield session

        await engine.dispose()

    @pytest.mark.asyncio
    async def test_oauth_login_new_user(self, db):
        """Test OAuth login creates a new user."""
        from auth.service import oauth_login, _create_oauth_binding

        mock_info = OAuthUserInfo(
            provider="github",
            provider_user_id="gh-99999",
            username="newgithub",
            email="newgithub@test.com",
            avatar_url="https://github.com/avatar.png",
            raw={"id": 99999, "login": "newgithub"},
        )

        with patch("auth.service.get_oauth_user_info", new_callable=AsyncMock) as mock:
            mock.return_value = mock_info
            user, is_new = await oauth_login(db, "github", "fake-code")

        assert is_new is True
        assert user.email == "newgithub@test.com"
        assert user.username == "newgithub"

    @pytest.mark.asyncio
    async def test_oauth_login_existing_binding(self, db):
        """Test OAuth login with existing binding returns same user."""
        from auth.service import oauth_login

        # Pre-create user + OAuth binding
        user = User(email="existing@test.com", username="existing", is_verified=True)
        db.add(user)
        await db.flush()

        binding = OAuthAccount(
            user_id=user.id,
            provider=AuthProvider.GITHUB,
            provider_user_id="gh-123",
            provider_username="existing",
            provider_email="existing@test.com",
        )
        db.add(binding)
        await db.flush()

        mock_info = OAuthUserInfo(
            provider="github",
            provider_user_id="gh-123",
            username="existing",
            email="existing@test.com",
            avatar_url=None,
            raw={},
        )

        with patch("auth.service.get_oauth_user_info", new_callable=AsyncMock) as mock:
            mock.return_value = mock_info
            result_user, is_new = await oauth_login(db, "github", "code")

        assert is_new is False
        assert result_user.id == user.id

    @pytest.mark.asyncio
    async def test_oauth_email_auto_bind(self, db):
        """OAuth with matching email auto-binds to existing account."""
        from auth.service import oauth_login

        # Pre-create user via email registration
        existing = await register_by_email(db, "shared@test.com", "pass123", "shared")

        mock_info = OAuthUserInfo(
            provider="github",
            provider_user_id="gh-new",
            username="githubuser",
            email="shared@test.com",  # same email
            avatar_url=None,
            raw={},
        )

        with patch("auth.service.get_oauth_user_info", new_callable=AsyncMock) as mock:
            mock.return_value = mock_info
            user, is_new = await oauth_login(db, "github", "code")

        assert is_new is False
        assert user.id == existing.id

        # Verify binding was created
        from sqlalchemy import select
        result = await db.execute(
            select(OAuthAccount).where(OAuthAccount.user_id == existing.id)
        )
        bindings = result.scalars().all()
        assert len(bindings) == 1
        assert bindings[0].provider == AuthProvider.GITHUB


# ========================================================================
# Model Tests
# ========================================================================

class TestModels:
    def test_auth_provider_values(self):
        assert AuthProvider.LOCAL.value == "local"
        assert AuthProvider.WECHAT.value == "wechat"
        assert AuthProvider.GITHUB.value == "github"

    def test_member_role_values(self):
        assert MemberRole.OWNER.value == "owner"
        assert MemberRole.ADMIN.value == "admin"
        assert MemberRole.MEMBER.value == "member"
        assert MemberRole.VIEWER.value == "viewer"

    def test_tenant_member_permissions(self):
        owner = TenantMember(role=MemberRole.OWNER)
        admin = TenantMember(role=MemberRole.ADMIN)
        member = TenantMember(role=MemberRole.MEMBER)
        viewer = TenantMember(role=MemberRole.VIEWER)

        assert owner.is_owner is True
        assert owner.is_admin_or_above is True
        assert admin.is_admin_or_above is True
        assert member.is_admin_or_above is False
        assert viewer.is_admin_or_above is False
