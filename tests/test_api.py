"""Tests for API layer"""

import sys
import os
import json

import pytest

project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# Check if FastAPI is available
pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient
from api.main import app, DB_PATH


@pytest.fixture(scope="function")
def client():
    """TestClient with startup events (creates auth tables)."""
    with TestClient(app) as c:
        # Register a test user and get token
        c.post("/auth/register", json={
            "email": "testuser@api.com",
            "password": "testpass123",
            "username": "api_tester",
        })
        r = c.post("/auth/login", json={
            "email": "testuser@api.com",
            "password": "testpass123",
        })
        token = r.json().get("access_token", "")
        assert token, f"Login failed: {r.text}"
        c._test_token = token
        yield c


@pytest.fixture(scope="function")
def auth_headers(client):
    """Auth headers for protected endpoints."""
    return {"Authorization": f"Bearer {client._test_token}"}


class TestHealthAndInfo:
    def test_health(self, client):
        resp = client.get("/api/agent/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["service"] == "data-agent"

    def test_tools(self, client):
        resp = client.get("/api/agent/tools")
        assert resp.status_code == 200
        data = resp.json()
        assert "tools" in data
        assert isinstance(data["tools"], list)


class TestQuery:
    def test_query_count(self, client, auth_headers):
        """Test a count question"""
        resp = client.post("/api/agent/query", json={
            "question": "IDCEVO 有多少 Critical 缺陷",
            "use_memory": False,
        }, headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "success" in data
        assert "answer" in data
        assert "total_time_ms" in data

    def test_query_distribution(self, client, auth_headers):
        """Test a distribution question"""
        resp = client.post("/api/agent/query", json={
            "question": "缺陷按项目分布",
            "use_memory": False,
        }, headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "success" in data

    def test_query_trend(self, client, auth_headers):
        """Test a trend question"""
        resp = client.post("/api/agent/query", json={
            "question": "IDCEVO 缺陷趋势",
            "use_memory": False,
        }, headers=auth_headers)
        assert resp.status_code == 200

    def test_query_with_memory(self, client, auth_headers):
        """Test query with memory recording"""
        resp = client.post("/api/agent/query", json={
            "question": "活跃缺陷有多少",
            "use_memory": True,
        }, headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        if data["success"]:
            assert data["memory_record_id"] is not None

    def test_query_empty_question(self, client, auth_headers):
        """Empty question should fail validation"""
        resp = client.post("/api/agent/query", json={"question": ""}, headers=auth_headers)
        assert resp.status_code == 422  # validation error


class TestSSEStream:
    def test_stream_basic(self, client):
        """Test SSE streaming"""
        with client.stream("GET", "/api/agent/stream", params={"question": "缺陷数量"}) as resp:
            assert resp.status_code == 200
            assert "text/event-stream" in resp.headers.get("content-type", "")

            events = []
            for line in resp.iter_lines():
                if line.startswith("event:"):
                    events.append(line.split(":", 1)[1].strip())
                elif line.startswith("data:"):
                    pass  # data line

            # Should have at least start and done events
            assert len(events) > 0
            assert "start" in events or "done" in events


class TestFeedback:
    def test_feedback_invalid_type(self, client, auth_headers):
        """Invalid feedback type should 400"""
        resp = client.post("/api/agent/feedback", json={
            "query_memory_id": "fake",
            "feedback": "invalid",
        }, headers=auth_headers)
        assert resp.status_code == 400

    def test_feedback_not_found(self, client, auth_headers):
        """Non-existent memory ID should 404"""
        resp = client.post("/api/agent/feedback", json={
            "query_memory_id": "nonexistent_id_123",
            "feedback": "up",
        }, headers=auth_headers)
        assert resp.status_code == 404

    def test_feedback_success(self, client, auth_headers):
        """Record a query first, then give feedback"""
        # First, record a query
        resp = client.post("/api/agent/query", json={
            "question": "测试反馈查询",
            "use_memory": True,
        }, headers=auth_headers)
        data = resp.json()
        
        if data["success"] and data.get("memory_record_id"):
            mem_id = data["memory_record_id"]
            
            # Give thumbs up
            resp2 = client.post("/api/agent/feedback", json={
                "query_memory_id": mem_id,
                "feedback": "up",
                "note": "回答准确",
            }, headers=auth_headers)
            assert resp2.status_code == 200
            assert resp2.json()["success"]


class TestHistoryAndStats:
    def test_history(self, client, auth_headers):
        resp = client.get("/api/agent/history", params={"limit": 5}, headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "records" in data
        assert "count" in data

    def test_stats(self, client, auth_headers):
        resp = client.get("/api/agent/stats", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "memory" in data
        assert "feedback" in data

    def test_examples(self, client):
        resp = client.get("/api/agent/examples", params={"limit": 10})
        assert resp.status_code == 200
        data = resp.json()
        assert "examples" in data
