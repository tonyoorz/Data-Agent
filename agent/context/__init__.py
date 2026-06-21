"""Context Module - 5-Layer Context Building

Provides:
- DataProfiler: Automatic database profiling
- ContextEngine: 5-layer context building (structural, semantic, business, operational, behavioral)
"""

from .engine import DataProfiler, ContextEngine, get_context_engine

__all__ = [
    "DataProfiler",
    "ContextEngine",
    "get_context_engine",
]