"""
Async SQLite database engine + session factory.

Two databases:
    - auth.db   → users, tenants, sessions
    - data.db   → business data (existing, per-tenant isolation supported)
"""

from __future__ import annotations

import os
from pathlib import Path
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
)

from .models import Base

# Auth DB path (separate from business data DB)
AUTH_DB_DIR = Path(os.getenv("AUTH_DB_DIR", Path(__file__).resolve().parent.parent / "data"))
AUTH_DB_DIR.mkdir(parents=True, exist_ok=True)
AUTH_DB_PATH = AUTH_DB_DIR / "auth.db"

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_auth_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            f"sqlite+aiosqlite:///{AUTH_DB_PATH}",
            echo=False,
            pool_pre_ping=True,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            get_auth_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return _session_factory


async def init_auth_db():
    """Create all auth tables. Call once on startup."""
    engine = get_auth_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@asynccontextmanager
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI-compatible async DB session context manager."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def db_session() -> AsyncGenerator[AsyncSession, None]:
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
