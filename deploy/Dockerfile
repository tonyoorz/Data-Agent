# syntax=docker/dockerfile:1
#
# Vizion Data-Agent — production image
# Two stages: build the Vite frontend, then assemble a Python3.12 + Node24 runtime.
# The same image runs BOTH the Node web+api process and the Python analytics service
# (different CMD). See deploy/docker-compose.yml / deploy/k8s.yaml.

# ---------------------------------------------------------------------------
# Stage 1 — build the frontend (needs Node 24, VITE_* are inlined into dist)
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS frontend
WORKDIR /build
COPY package.json package-lock.json bun.lock* ./
RUN npm ci
COPY . .
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_PUBLISHABLE_KEY=""
ARG VITE_SUPABASE_PROJECT_ID=""
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime (Python 3.12 exact + Node 24 exact)
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates libgomp1 fonts-dejavu-core \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps + venv (the app expects .venv/bin/python at repo root)
COPY requirements.txt ./
RUN python -m venv .venv \
    && .venv/bin/pip install --no-cache-dir --upgrade pip \
    && .venv/bin/pip install --no-cache-dir -r requirements.txt

# App source
COPY . .
# Built frontend from stage 1
COPY --from=frontend /build/dist ./dist

# Best-effort: bake the embedding model into the discovery path so the
# runtime never hits the network (BMW intranet usually cannot reach HF).
# Set --build-arg BAKE_MODELS=0 to skip (then mount a prepared model dir).
ARG BAKE_MODELS=1
RUN if [ "$BAKE_MODELS" = "1" ]; then \
        .venv/bin/python - <<'PY' || echo "WARN: embedding model bake failed; provide offline model mount"
from sentence_transformers import SentenceTransformer
import os
dest = "/app/backend/cache/embedding_models/modelscope/BAAI/bge-small-zh-v1.5"
os.makedirs(os.path.dirname(dest), exist_ok=True)
SentenceTransformer("BAAI/bge-small-zh-v1.5").save(dest)
print("embedded model baked to", dest)
PY
    fi

ENV TRANSFORMERS_OFFLINE=1 \
    HF_HUB_OFFLINE=1 \
    DUPLICATE_EMBEDDING_MODEL=/app/backend/cache/embedding_models/modelscope/BAAI/bge-small-zh-v1.5 \
    VIZION_AGENT_CHECKPOINT_DB=/data/agent-checkpoints.db \
    VIZION_DATABASE_ROOT=/data/database \
    PATH="/app/.venv/bin:$PATH"

RUN mkdir -p /data/database /data/agent
VOLUME ["/data"]

EXPOSE 3004 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3004/health || exit 1

# Default CMD = Node web+api. The analytics service overrides CMD in compose/k8s.
CMD ["node", "server/index.mjs"]
