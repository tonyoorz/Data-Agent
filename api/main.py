"""
Data-Agent API Server

FastAPI 服务，集成 Phase 1-4 全部能力。

启动:
    cd Data-Agent
    python3 -m api.main

    或:
    uvicorn api.main:app --host 0.0.0.0 --port 8100 --reload

接口:
    POST   /api/agent/query       — 同步查询
    GET    /api/agent/stream      — SSE 流式查询
    POST   /api/agent/feedback    — 用户反馈
    GET    /api/agent/history     — 查询历史
    GET    /api/agent/stats       — 记忆统计
    GET    /api/agent/health      — 健康检查
    GET    /api/agent/tools       — 工具列表
"""

from __future__ import annotations

import os
import sys
import json
import time
import asyncio
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, HTTPException, Query as QueryParam, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

# Auth imports
from auth.routes import router as auth_router, tenant_router
from auth.database import init_auth_db
from auth.deps import get_current_user, get_current_user_optional, get_current_tenant
from auth.models import User, Tenant
from auth.tenant_data import resolve_tenant_db_path, get_tenant_memory_db_path

logger = logging.getLogger("data-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

# Ensure project root is importable
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Agent imports
from agent.ontology import get_ontology_engine
from agent.agent_loop.loop import get_agent, StepType
from agent.agent_loop.registry import build_default_registry
from agent.agent_loop.streaming import SSEEventStream
from agent.learning import QueryMemory, FeedbackStore
from agent.interpret.storyteller import DataStoryteller, StoryType
from agent.data.adapter import resolve_data_db_path, execute_query
from agent.llm import get_llm_client


# ============================================================================
# Config
# ============================================================================

DB_PATH = os.environ.get("DATA_AGENT_DB_PATH", str(PROJECT_ROOT / "data" / "agent_memory.db"))

# Resolve data source DB (sample or production)
# Production: set DATA_DB_PATH to point to local_data_rebuilt.db
# Development: auto-creates sample DB with 500 mock defects
DATA_DB_PATH = resolve_data_db_path()

# Ensure data directory exists
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

# ============================================================================
# Singletons (lazy init)
# ============================================================================

_ontology = None
_agent = None
_query_memory = None
_feedback_store = None
_storyteller = None
_llm_client = None


def get_ontology():
    global _ontology
    if _ontology is None:
        ontology_dir = PROJECT_ROOT / "agent" / "ontology"
        _ontology = get_ontology_engine(ontology_dir)
    return _ontology


def get_query_memory() -> QueryMemory:
    global _query_memory
    if _query_memory is None:
        _query_memory = QueryMemory(db_path=DB_PATH)
    return _query_memory


def get_feedback_store() -> FeedbackStore:
    global _feedback_store
    if _feedback_store is None:
        _feedback_store = FeedbackStore(db_path=DB_PATH)
    return _feedback_store


def get_storyteller() -> DataStoryteller:
    global _storyteller
    if _storyteller is None:
        _storyteller = DataStoryteller()
    return _storyteller


def get_llm():
    """Get or create the LLM client singleton"""
    global _llm_client
    if _llm_client is None:
        _llm_client = get_llm_client()
    return _llm_client


def get_data_agent():
    global _agent
    if _agent is None:
        ont = get_ontology()

        # Determine mode from env
        agent_mode = os.environ.get("AGENT_MODE", "llm")
        llm = get_llm()

        if agent_mode == "llm" and llm:
            # LLM-powered mode
            agent_fn = llm.as_agent_fn()
            logger.info("Agent starting in LLM mode")
        else:
            agent_fn = None
            logger.info("Agent starting in rule-based mode")

        _agent = get_agent(
            ontology=ont,
            db_path=DATA_DB_PATH or None,
            llm_call_fn=agent_fn,
        )
    return _agent


# ============================================================================
# Session Manager Singleton
# ============================================================================

_session_manager = None
_session_agents: Dict[str, Any] = {}  # session_id -> agent instance


def get_session_manager():
    global _session_manager
    if _session_manager is None:
        from agent.conversation import SessionManager
        _session_manager = SessionManager()
    return _session_manager


def get_agent_for_session(
    session_id: Optional[str],
    data_db: Optional[str] = None,
    memory_db: Optional[str] = None,
):
    """
    Get or create agent for a session.
    
    Each session needs its own agent instance with independent
    ConversationContext for multi-turn dialogue.
    Supports per-tenant DB paths for data isolation.
    """
    global _session_agents
    
    # Use provided DB paths or defaults
    effective_data_db = data_db or DATA_DB_PATH
    effective_memory_db = memory_db or DB_PATH
    
    # Create cache key from session_id + DB paths (so different tenants get different agents)
    cache_key = f"{session_id or 'default'}:{effective_data_db}"
    
    # If no session_id, use default agent (stateless, single-turn)
    if not session_id:
        # But check if we need a custom data DB (tenant-specific)
        if effective_data_db != DATA_DB_PATH:
            if cache_key in _session_agents:
                return _session_agents[cache_key]
            agent = _create_agent(effective_data_db)
            _session_agents[cache_key] = agent
            return agent
        return get_data_agent()
    
    # Check if we have an agent for this session+tenant combo
    if cache_key in _session_agents:
        return _session_agents[cache_key]
    
    # Create new agent for this session
    agent = _create_agent(effective_data_db)
    
    # Replace agent's conversation context with session-specific one
    sess_mgr = get_session_manager()
    agent.conversation = sess_mgr.get_session(session_id)
    
    _session_agents[cache_key] = agent
    return agent


def _create_agent(data_db_path: str):
    """Create a fresh agent instance with the given data DB path."""
    ont = get_ontology()
    agent_mode = os.environ.get("AGENT_MODE", "llm")
    llm = get_llm()
    
    agent_fn = None
    if agent_mode == "llm" and llm:
        agent_fn = llm.as_agent_fn()
    
    agent = get_agent(
        ontology=ont,
        db_path=data_db_path or None,
        llm_call_fn=agent_fn,
    )
    return agent


# ============================================================================
# Request / Response Models
# ============================================================================

class QueryRequest(BaseModel):
    question: str = Field(..., description="用户自然语言问题", min_length=1, max_length=500)
    use_memory: bool = Field(True, description="是否使用查询记忆")
    stream: bool = Field(False, description="是否流式返回")
    session_id: Optional[str] = Field(None, description="会话 ID (多轮对话时传此值)")


class QueryResponse(BaseModel):
    success: bool
    answer: str
    steps: List[Dict[str, Any]] = []
    tools_used: List[str] = []
    sql_executed: List[str] = []
    story: Optional[Dict[str, Any]] = None
    memory_record_id: Optional[str] = None
    session_id: Optional[str] = None
    turn_type: Optional[str] = None
    resolved_question: Optional[str] = None
    total_time_ms: float = 0


class FeedbackRequest(BaseModel):
    query_memory_id: str = Field(..., description="查询记忆 ID")
    feedback: str = Field(..., description="'up' or 'down'")
    note: str = Field("", description="用户备注")
    correction: str = Field("", description="用户认为正确的方向")


class SessionCreateRequest(BaseModel):
    user_id: Optional[str] = Field(None, description="用户 ID")
    session_id: Optional[str] = Field(None, description="指定会话 ID（可选，不指定则自动生成）")


class SessionCreateResponse(BaseModel):
    session_id: str
    message: str


class FeedbackResponse(BaseModel):
    success: bool
    feedback_id: str
    message: str


# ============================================================================
# FastAPI App
# ============================================================================

app = FastAPI(
    title="Data-Agent API",
    description="Ontology-driven intelligent data analysis agent",
    version="1.0.0",
)

# CORS — allow frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # production: restrict to known origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register auth routers
app.include_router(auth_router)
app.include_router(tenant_router)


# ============================================================================
# Routes
# ============================================================================

@app.on_event("startup")
async def _startup_auth():
    """Initialize auth database tables on startup."""
    from auth.database import init_auth_db
    await init_auth_db()
    logger.info("Auth database initialized")


@app.get("/api/agent/health")
async def health():
    """健康检查"""
    # Check LLM status
    llm = get_llm()
    llm_status = "disabled"
    if llm:
        llm_status = f"{llm.provider}/{llm.model}"

    return {
        "status": "ok",
        "service": "data-agent",
        "version": "1.0.0",
        "phases": {
            "ontology": True,
            "nl2sql": True,
            "agent_loop": True,
            "learning": True,
            "storyteller": True,
            "llm": llm is not None,
        },
        "llm": {
            "provider": llm.provider if llm else "none",
            "model": llm.model if llm else "none",
            "status": llm_status,
        },
        "mode": os.environ.get("AGENT_MODE", "llm"),
    }


@app.get("/api/agent/tools")
async def list_tools():
    """列出可用工具"""
    ont = get_ontology()
    registry = build_default_registry(ontology=ont, db_path=DATA_DB_PATH or None)
    schemas = registry.get_schemas()
    descriptions = registry.get_descriptions()  # returns markdown string
    tool_names = [s.get("function", {}).get("name", "") if isinstance(s, dict) else "" for s in schemas]
    return {
        "tools": tool_names,
        "count": len(tool_names),
        "descriptions": descriptions,
    }


@app.post("/api/agent/query", response_model=QueryResponse)
async def query(
    req: QueryRequest,
    user: User = Depends(get_current_user),
    tenant: Optional[Tenant] = Depends(get_current_tenant),
):
    """
    同步查询接口

    完整流程:
    1. (可选) 从 QueryMemory 检索相似历史
    2. Agent ReAct Loop 执行
    3. DataStoryteller 解读结果
    4. 存入 QueryMemory
    """
    t0 = time.time()

    # Resolve tenant-specific paths
    data_db = resolve_tenant_db_path(tenant)
    memory_db = get_tenant_memory_db_path(tenant)

    # Get or create session-specific agent
    agent = get_agent_for_session(req.session_id, data_db=data_db, memory_db=memory_db)

    try:
        response = agent.process(req.question)
        
        # Extract turn type and resolved question from the agent
        turn_type = None
        resolved_question = None
        if response.steps:
            for step in response.steps:
                if step.content and "上下文解析" in step.content:
                    import re
                    m = re.search(r"类型: (\w+)", step.content)
                    if m:
                        turn_type = m.group(1)
                    m2 = re.search(r"→ '([^']+)'", step.content)
                    if m2:
                        resolved_question = m2.group(1)
                    break

        # Build story if we have data
        story = None
        teller = get_storyteller()

        # Determine story type from response
        tools_used = response.tools_used
        if response.success and response.steps:
            last_tool = tools_used[-1] if tools_used else ""
            if "query_defects" in last_tool:
                count = _extract_count(response.answer)
                if count is not None:
                    story = teller.tell_count(count).to_dict()
            elif "query_trend" in last_tool:
                for step in response.steps:
                    if step.step_type == StepType.OBSERVATION and step.tool_output and step.tool_output.data:
                        rows = extract_rows(step.tool_output.data)
                        if rows:
                            story = teller.tell_trend(rows).to_dict()
                            break
            elif "get_distribution" in last_tool:
                for step in response.steps:
                    if step.step_type == StepType.OBSERVATION and step.tool_output and step.tool_output.data:
                        rows = extract_rows(step.tool_output.data)
                        if rows:
                            story = teller.tell_distribution(rows, dimension="结果").to_dict()
                            break
            elif "get_ranking" in last_tool:
                for step in response.steps:
                    if step.step_type == StepType.OBSERVATION and step.tool_output and step.tool_output.data:
                        rows = extract_rows(step.tool_output.data)
                        if rows:
                            story = teller.tell_ranking(rows, rank_by="排名维度").to_dict()
                            break
            elif "get_dashboard" in last_tool:
                stats = {"total": 0, "active": 0, "critical": 0, "resolved": 0}
                for step in response.steps:
                    if step.step_type == StepType.OBSERVATION and step.tool_output and step.tool_output.data:
                        rows = extract_rows(step.tool_output.data)
                        for row in rows:
                            if isinstance(row, dict):
                                stats["total"] += row.get("count", 0)
                story = teller.tell_summary(stats).to_dict()

        # Record to memory
        memory_id = None
        if req.use_memory and response.success:
            mem = get_query_memory()
            sql_list = response.sql_executed
            memory_id = mem.record(
                question=req.question,
                sql=sql_list[0] if sql_list else "",
                intent=response.steps[0].tool_name if response.steps else "",
                result_summary=response.answer[:200],
                result_count=_extract_count(response.answer) or 0,
                success=response.success,
            )

        elapsed = (time.time() - t0) * 1000

        return QueryResponse(
            success=response.success,
            answer=response.answer,
            steps=[{
                "type": s.step_type.value,
                "content": s.content,
                "tool": s.tool_name,
                "tool_input": s.tool_input,
                "tool_output": s.tool_output.data if s.tool_output else None,
            } for s in response.steps],
            tools_used=tools_used,
            sql_executed=response.sql_executed,
            story=story,
            memory_record_id=memory_id,
            session_id=req.session_id,
            turn_type=turn_type,
            resolved_question=resolved_question,
            total_time_ms=round(elapsed, 1),
        )

    except Exception as e:
        elapsed = (time.time() - t0) * 1000
        import traceback
        traceback.print_exc()
        return QueryResponse(
            success=False,
            answer=f"查询失败: {str(e)}",
            total_time_ms=round(elapsed, 1),
        )


@app.get("/api/agent/stream")
async def stream_query(
    question: str = QueryParam(..., description="用户问题"),
):
    """
    SSE 流式查询接口

    事件类型:
    - start: 查询开始
    - thought: Agent 思考
    - action: 工具调用
    - observation: 结果观察
    - final: 最终回答
    - done: 结束
    """
    async def event_generator():
        agent = get_data_agent()

        # start event
        yield f"event: start\ndata: {json.dumps({'question': question, 'timestamp': time.time()})}\n\n"

        try:
            for event in agent.process_stream(question):
                yield f"event: {event.event_type}\ndata: {json.dumps(event.data, ensure_ascii=False, default=str)}\n\n"
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

        # done event
        yield f"event: done\ndata: {json.dumps({'timestamp': time.time()})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/agent/feedback", response_model=FeedbackResponse)
async def feedback(
    req: FeedbackRequest,
    user: User = Depends(get_current_user),
    tenant: Optional[Tenant] = Depends(get_current_tenant),
):
    """用户反馈接口"""
    if req.feedback not in ("up", "down"):
        raise HTTPException(status_code=400, detail="feedback must be 'up' or 'down'")

    mem = get_query_memory()
    fb = get_feedback_store()
    record = mem.get_by_id(req.query_memory_id)
    if not record:
        raise HTTPException(status_code=404, detail="Query memory record not found")

    fid = fb.record(
        query_memory_id=req.query_memory_id,
        feedback_type=req.feedback,
        note=req.note,
        question=record.question,
        sql=record.sql,
        correction=req.correction,
    )

    return FeedbackResponse(
        success=True,
        feedback_id=fid,
        message=f"Feedback '{req.feedback}' recorded",
    )


@app.get("/api/agent/history")
async def history(
    limit: int = QueryParam(20, ge=1, le=100),
    user: User = Depends(get_current_user),
):
    """查询历史记录"""
    mem = get_query_memory()
    records = mem.get_recent(limit=limit)
    return {
        "records": [r.to_dict() for r in records],
        "count": len(records),
    }


@app.get("/api/agent/stats")
async def stats(
    user: User = Depends(get_current_user),
):
    """记忆和反馈统计"""
    mem = get_query_memory()
    fb = get_feedback_store()

    mem_stats = mem.get_statistics()
    fb_stats = fb.get_statistics()

    return {
        "memory": mem_stats,
        "feedback": fb_stats,
        "weight_adjustments": fb.get_weight_adjustments(),
    }


@app.post("/api/agent/session", response_model=SessionCreateResponse)
async def create_session(
    req: SessionCreateRequest,
    user: User = Depends(get_current_user),
):
    """创建新会话（多轮对话）"""
    import uuid
    session_id = req.session_id or str(uuid.uuid4())
    
    # Get or create session
    sess_mgr = get_session_manager()
    ctx = sess_mgr.get_session(session_id)
    
    return SessionCreateResponse(
        session_id=session_id,
        message=f"会话 {session_id} 已创建",
    )


@app.delete("/api/agent/session/{session_id}")
async def delete_session(
    session_id: str,
    user: User = Depends(get_current_user),
):
    """删除会话"""
    sess_mgr = get_session_manager()
    sess_mgr.remove_session(session_id)
    
    # Remove cached agent
    global _session_agents
    _session_agents.pop(session_id, None)
    
    return {"message": f"会话 {session_id} 已删除"}


@app.get("/api/agent/sessions")
async def list_sessions(
    user: User = Depends(get_current_user),
):
    """列出活跃会话"""
    sess_mgr = get_session_manager()
    active = sess_mgr.get_active_sessions()
    
    # Get turn counts for each session
    result = []
    for sid in active:
        ctx = sess_mgr.get_session(sid)
        result.append({
            "session_id": sid,
            "turn_count": len(ctx.history),
            "last_turn": ctx.history[-1]["question"] if ctx.history else None,
        })
    
    return {"sessions": result, "count": len(result)}


@app.get("/api/agent/session/{session_id}")
async def get_session(
    session_id: str,
    user: User = Depends(get_current_user),
):
    """获取会话详情"""
    sess_mgr = get_session_manager()
    try:
        ctx = sess_mgr.get_session(session_id)
        return {
            "session_id": session_id,
            "turn_count": len(ctx.history),
            "history": ctx.history,
        }
    except Exception:
        raise HTTPException(status_code=404, detail="会话不存在")


@app.get("/api/agent/examples")
async def examples(limit: int = QueryParam(30, ge=1, le=100)):
    """导出高分查询为 few-shot 示例"""
    mem = get_query_memory()
    data = mem.export_examples(limit=limit)
    return {
        "examples": data,
        "count": len(data),
    }


# ============================================================================
# LLM Management
# ============================================================================

@app.get("/api/agent/llm/status")
async def llm_status():
    """查看 LLM 状态"""
    llm = get_llm()
    if llm is None:
        return {
            "enabled": False,
            "provider": "none",
            "model": "none",
            "message": "LLM 未配置。设置 AGENT_LLM_PROVIDER 和 API key 启用。",
        }
    return {
        "enabled": True,
        "provider": llm.provider,
        "model": llm.model,
        "base_url": llm.base_url,
        "agent_mode": os.environ.get("AGENT_MODE", "llm"),
    }


@app.post("/api/agent/llm/test")
async def llm_test():
    """测试 LLM 连通性"""
    llm = get_llm()
    if llm is None:
        return {"success": False, "error": "LLM not configured"}

    ok = llm.health_check()
    return {
        "success": ok,
        "provider": llm.provider,
        "model": llm.model,
        "message": "LLM 响应正常" if ok else "LLM 无响应",
    }


@app.get("/api/agent/values/stats")
async def value_stats():
    """查看值索引统计"""
    from agent.data.value_retriever import get_value_retriever
    vr = get_value_retriever(db_path=DATA_DB_PATH or None, ontology=get_ontology())
    return vr.stats()


@app.get("/api/agent/values/search")
async def value_search(
    q: str = QueryParam(..., description="搜索文本"),
    field: Optional[str] = QueryParam(None, description="限定字段"),
):
    """搜索数据库值 (Value Retrieval)"""
    from agent.data.value_retriever import get_value_retriever
    vr = get_value_retriever(db_path=DATA_DB_PATH or None, ontology=get_ontology())
    r = vr.retrieve(q, field=field)
    return {
        "query": q,
        "matches": [
            {"value": m.value, "field": m.field, "score": m.score, "source": m.source}
            for m in r.matches
        ],
    }


# ============================================================================
# Helpers
# ============================================================================

def _extract_count(text: str) -> Optional[int]:
    """从回答文本中提取数字"""
    import re
    # Match patterns like "共有 42 个" or "= 42" or "总计 42"
    patterns = [
        r'(\d+)\s*个',
        r'共\s*(\d+)',
        r'总计\s*(\d+)',
        r'[:：]\s*(\d+)',
        r'=\s*(\d+)',
        r'\b(\d+)\b',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                continue
    return None


def extract_rows(data) -> list:
    """从 tool_output.data 提取 rows，兼容 list 和 dict 格式"""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "rows" in data:
            return data["rows"]
        if "data" in data:
            return data["data"]
        return [data]
    return []


# ============================================================================
# Main entry
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8100)),
        reload=True,
    )
