#!/usr/bin/env bash
# Pre-stage the embedding model so the runtime can run fully OFFLINE.
# Run on a machine WITH internet access (or inside the Docker build, which already
# does this). Output lands in the path the app auto-discovers:
#   backend/cache/embedding_models/modelscope/BAAI/bge-small-zh-v1.5
#
# Usage:
#   ./deploy/scripts/prestage-models.sh            # uses ./backend/cache/...
#   VIZION_VENV=/path/to/.venv ./deploy/scripts/prestage-models.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="${VIZION_VENV:-$REPO_ROOT/.venv}"
PY="$VENV/bin/python"
DEST="$REPO_ROOT/backend/cache/embedding_models/modelscope/BAAI/bge-small-zh-v1.5"

if [ ! -x "$PY" ]; then
  echo "venv python not found at $PY — create it first: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

echo ">> Downloading + saving BAAI/bge-small-zh-v1.5 -> $DEST"
"$PY" - <<PY
from sentence_transformers import SentenceTransformer
import os
dest = "$DEST"
os.makedirs(os.path.dirname(dest), exist_ok=True)
SentenceTransformer("BAAI/bge-small-zh-v1.5").save(dest)
print("OK ->", dest)
PY

echo ">> To bake into the image offline, copy this dir into the image at the same path,"
echo "   or rely on the Dockerfile BAKE_MODELS=1 step (needs build-time internet)."
echo ">> RapidOCR weights: if you need fully offline OCR, download det/rec/cls .onnx and set"
echo "   DUPSEARCH_RAPIDOCR_DET_MODEL / DUPSEARCH_RAPIDOCR_REC_MODEL / DUPSEARCH_RAPIDOCR_CLS_MODEL."
