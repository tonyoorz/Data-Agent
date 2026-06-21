"""
Data Module — 数据源适配

提供统一的数据访问接口，上层 Agent 不需要关心数据源在哪里。
"""

from agent.data.adapter import (
    init_sample_database,
    resolve_data_db_path,
    execute_query,
    DEFECTS_SCHEMA,
    MANUAL_RUNS_SCHEMA,
)

__all__ = [
    "init_sample_database",
    "resolve_data_db_path",
    "execute_query",
    "DEFECTS_SCHEMA",
    "MANUAL_RUNS_SCHEMA",
]
