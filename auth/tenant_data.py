"""
Tenant data isolation — resolve per-tenant DB paths and data adapters.

Each tenant can have:
    - A dedicated SQLite DB (tenant.db_path set) → full isolation
    - Shared DB (tenant.db_path null) → fallback to default DATA_DB_PATH

Usage in API routes:
    tenant = Depends(get_current_tenant)
    db_path = resolve_tenant_db_path(tenant)
"""

from __future__ import annotations

import os
import logging
from pathlib import Path
from typing import Optional

from auth.models import Tenant
from agent.data.adapter import resolve_data_db_path

logger = logging.getLogger("data-agent.tenant")

# Default shared data DB path
DEFAULT_DATA_DB = resolve_data_db_path()

# Tenant data root directory
TENANT_DATA_ROOT = Path(
    os.getenv("TENANT_DATA_ROOT", Path(__file__).resolve().parent.parent / "data" / "tenants")
)


def resolve_tenant_db_path(tenant: Optional[Tenant]) -> str:
    """
    Resolve the business data DB path for a given tenant.

    If tenant has db_path set → use it.
    Otherwise → fallback to shared default DB.
    """
    if tenant and tenant.db_path:
        # If relative, resolve under tenant data root
        p = Path(tenant.db_path)
        if not p.is_absolute():
            p = TENANT_DATA_ROOT / tenant.slug / tenant.db_path
        # Ensure directory exists
        p.parent.mkdir(parents=True, exist_ok=True)
        return str(p)

    # Fallback to shared default
    return DEFAULT_DATA_DB


def get_tenant_data_dir(tenant: Optional[Tenant]) -> Path:
    """Get the data directory for a tenant (for file uploads, exports, etc.)."""
    if tenant:
        d = TENANT_DATA_ROOT / tenant.slug
    else:
        d = TENANT_DATA_ROOT / "_shared"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_tenant_memory_db_path(tenant: Optional[Tenant]) -> str:
    """Get the agent memory DB path for a tenant (query memory, feedback)."""
    if tenant:
        d = TENANT_DATA_ROOT / tenant.slug
        d.mkdir(parents=True, exist_ok=True)
        return str(d / "agent_memory.db")

    # Fallback: shared memory DB
    project_root = Path(__file__).resolve().parent.parent
    return str(project_root / "data" / "agent_memory.db")
