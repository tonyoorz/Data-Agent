"""
Data Adapter Layer — 数据源适配器

负责连接不同的数据源：
1. 本地 sample 数据（开发测试用）
2. 生产 Octane SQLite 数据库（另一台电脑）
3. PostgreSQL（生产可选）

设计原则：
- 上层 Agent 只管调用 SQL，不关心数据源在哪
- 通过环境变量 DATA_DB_PATH 切换数据源
- Schema 保持与生产库一致（octane_defects 表结构）
"""

from __future__ import annotations

import os
import json
import sqlite3
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any


# ============================================================================
# Schema — 与生产库 db_storage.py 保持一致
# ============================================================================

DEFECTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS octane_defects (
    defect_id TEXT PRIMARY KEY,
    year INTEGER,
    creation_time TEXT,
    summary TEXT,
    description TEXT,
    status_phase TEXT,
    severity TEXT,
    project TEXT,
    detected_by TEXT,
    detected_in_release TEXT,
    domain TEXT,
    aidas TEXT,
    top_aida TEXT,
    tags TEXT,
    classification TEXT,
    pingpong INTEGER DEFAULT 0,
    vin TEXT,
    ecu TEXT,
    source_file TEXT
)
"""

MANUAL_RUNS_SCHEMA = """
CREATE TABLE IF NOT EXISTS octane_manual_runs (
    run_id TEXT,
    report_period TEXT,
    test_id TEXT,
    test_name TEXT,
    run_status TEXT,
    tester TEXT,
    finished_time TEXT,
    test_week TEXT,
    project TEXT,
    model TEXT,
    aidas TEXT,
    top_aida TEXT,
    PRIMARY KEY (report_period, run_id)
)
"""

DEFECT_HISTORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS octane_defect_history_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    defect_id TEXT,
    event_time TEXT,
    user TEXT,
    event_type TEXT,
    from_phase TEXT,
    to_phase TEXT,
    details TEXT
)
"""


# ============================================================================
# Sample Data Generator — 生成模拟缺陷数据
# ============================================================================

PROJECTS = ['IDCEVO', 'IDC', 'MGU', 'APA', 'ICM']
SEVERITIES = ['Critical', 'Major', 'Minor']
STATUSES = ['New', 'Open', 'In Progress', 'Fixed', 'Closed', 'Rejected', 'Deferred']
ECUS = ['BCM', 'IDC', 'IDCEVO', 'APA', 'ICM', 'ADAS', 'Cluster', 'Gateway', 'V2X', 'DMS']
RELEASES = ['R026', 'R027', 'R028', 'R029', 'R030', 'R031']
DOMAINS = ['Software', 'Hardware', 'System', 'Mechanical', 'Integration']
TESTERS = [
    '张伟', '李明', '王强', '陈杰', '刘洋',
    '赵磊', '黄涛', '周鹏', '吴昊', '徐辉',
]


def generate_sample_defects(n: int = 500, year: int = 2026) -> List[Dict[str, Any]]:
    """生成模拟缺陷数据"""
    random.seed(42)
    defects = []
    base_time = datetime(year, 1, 1)

    for i in range(1, n + 1):
        created = base_time + timedelta(
            days=random.randint(0, 170),
            hours=random.randint(0, 23),
        )

        ecu = random.choice(ECUS)
        project = random.choice(PROJECTS)
        severity = random.choices(SEVERITIES, weights=[15, 50, 35])[0]
        status = random.choices(STATUSES, weights=[10, 20, 15, 25, 20, 5, 5])[0]

        # Critical 倾向于更多在 Open/In Progress
        if severity == 'Critical' and random.random() < 0.4:
            status = random.choice(['New', 'Open', 'In Progress'])

        defect = {
            'defect_id': f'DEF-{year}-{i:05d}',
            'year': year,
            'creation_time': created.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'summary': f'{ecu} {severity} 级别问题 #{i}: {random.choice(["功能异常", "通信超时", "信号错误", "显示异常", "性能不达标"])}',
            'description': f'在 {project} 项目 {ecu} 模块测试中发现的 {severity} 级别缺陷',
            'status_phase': status,
            'severity': severity,
            'project': project,
            'detected_by': random.choice(TESTERS),
            'detected_in_release': random.choice(RELEASES),
            'domain': random.choice(DOMAINS),
            'aidas': json.dumps(random.sample(['SA1', 'SA2', 'SA3', 'BR1', 'BR2', 'AD1'], k=random.randint(1, 3))),
            'top_aida': random.choice(['SA1', 'SA2', 'BR1', 'AD1']),
            'tags': json.dumps(random.sample(['回归', '新增', '偶发', '必现', '环境相关'], k=random.randint(0, 2))),
            'classification': json.dumps([random.choice(['Functional', 'Performance', 'Interface', 'Crash'])]),
            'pingpong': random.randint(0, 5) if random.random() > 0.7 else 0,
            'vin': f'LSG{random.randint(100000, 999999)}' if random.random() > 0.6 else '',
            'ecu': ecu,
            'source_file': f'{year}_defect.json',
        }
        defects.append(defect)

    return defects


def generate_sample_runs(n: int = 300) -> List[Dict[str, Any]]:
    """生成模拟测试执行数据"""
    random.seed(43)
    runs = []
    periods = [f'R{p}' for p in range(26, 32)]

    for i in range(1, n + 1):
        run = {
            'run_id': f'RUN-{i:06d}',
            'report_period': random.choice(periods),
            'test_id': f'TC-{random.randint(1, 200):04d}',
            'test_name': f'测试用例 {random.choice(["通信", "功能", "性能", "安全", "兼容"])} #{i}',
            'run_status': random.choices(['Passed', 'Failed', 'N/A', 'Blocked'], weights=[60, 25, 10, 5])[0],
            'tester': random.choice(TESTERS),
            'finished_time': datetime(2026, random.randint(1, 6), random.randint(1, 28)).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'test_week': f'2026-CW{random.randint(1, 25):02d}',
            'project': random.choice(PROJECTS),
            'model': random.choice(['ModelA', 'ModelB', 'ModelC']),
            'aidas': json.dumps(random.sample(['SA1', 'SA2', 'BR1'], k=1)),
            'top_aida': random.choice(['SA1', 'SA2', 'BR1']),
        }
        runs.append(run)

    return runs


# ============================================================================
# Database Initializer
# ============================================================================

def init_sample_database(db_path: str, n_defects: int = 500, n_runs: int = 300):
    """
    初始化样本数据库
    
    如果数据库已存在且有数据，不会覆盖。
    """
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    
    conn = sqlite3.connect(db_path)
    conn.execute(DEFECTS_SCHEMA)
    conn.execute(MANUAL_RUNS_SCHEMA)
    conn.execute(DEFECT_HISTORY_SCHEMA)

    # Check if already has data
    count = conn.execute("SELECT COUNT(*) FROM octane_defects").fetchone()[0]
    if count > 0:
        conn.close()
        return False  # already initialized

    # Generate and insert sample data
    defects = generate_sample_defects(n_defects)
    for d in defects:
        conn.execute("""
            INSERT OR REPLACE INTO octane_defects
            (defect_id, year, creation_time, summary, description, status_phase,
             severity, project, detected_by, detected_in_release, domain,
             aidas, top_aida, tags, classification, pingpong, vin, ecu, source_file)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            d['defect_id'], d['year'], d['creation_time'], d['summary'],
            d['description'], d['status_phase'], d['severity'], d['project'],
            d['detected_by'], d['detected_in_release'], d['domain'],
            d['aidas'], d['top_aida'], d['tags'], d['classification'],
            d['pingpong'], d['vin'], d['ecu'], d['source_file'],
        ))

    runs = generate_sample_runs(n_runs)
    for r in runs:
        conn.execute("""
            INSERT OR REPLACE INTO octane_manual_runs
            (run_id, report_period, test_id, test_name, run_status, tester,
             finished_time, test_week, project, model, aidas, top_aida)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            r['run_id'], r['report_period'], r['test_id'], r['test_name'],
            r['run_status'], r['tester'], r['finished_time'], r['test_week'],
            r['project'], r['model'], r['aidas'], r['top_aida'],
        ))

    # Create indexes
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defects_project ON octane_defects(project)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defects_severity ON octane_defects(severity)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defects_status ON octane_defects(status_phase)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defects_ecu ON octane_defects(ecu)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defects_creation ON octane_defects(creation_time)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defects_year ON octane_defects(year)")

    conn.commit()
    conn.close()
    return True


# ============================================================================
# Data source resolver
# ============================================================================

def resolve_data_db_path() -> str:
    """
    解析数据源 DB 路径

    优先级:
    1. 环境变量 DATA_DB_PATH（生产环境用）
    2. 本地 sample 数据库

    生产环境部署时:
        export DATA_DB_PATH=/path/to/local_data_rebuilt.db
    """
    env_path = os.environ.get("DATA_DB_PATH", "")
    if env_path and os.path.exists(env_path):
        return env_path

    # Default: sample DB in data/
    sample_path = str(Path(__file__).resolve().parent.parent.parent / "data" / "sample_defects.db")
    if not os.path.exists(sample_path):
        print(f"[DataAdapter] Initializing sample database at {sample_path} ...")
        init_sample_database(sample_path)
    return sample_path


# ============================================================================
# Query helper
# ============================================================================

def execute_query(db_path: str, sql: str) -> Dict[str, Any]:
    """
    执行 SQL 查询，返回标准化结果
    
    Returns:
        { "columns": [...], "rows": [...], "rowcount": N }
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(sql)
        rows = cursor.fetchall()
        columns = [d[0] for d in cursor.description] if cursor.description else []
        return {
            "columns": columns,
            "rows": [dict(r) for r in rows],
            "rowcount": len(rows),
        }
    finally:
        conn.close()
