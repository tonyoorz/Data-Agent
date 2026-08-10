# Main Agent Runtime Dependency Review

Phase 1 adds pinned Runtime dependencies: `@langchain/core@1.2.2`, `@langchain/langgraph@1.4.7`, `@langchain/langgraph-checkpoint-sqlite@1.0.3`, `ajv@8.20.0`, `ajv-formats@3.0.1`, and `better-sqlite3@12.11.1`.

All are used inside the local Node Runtime. External tracing is disabled by default; LangSmith transitive clients are not configured with credentials. Production rollout still requires company OSS approval, SBOM capture, vulnerability sign-off, and native-addon verification for Node 24/Linux.

Required evidence commands:

```bash
npm ci
npm ls --all > artifacts/qualification/npm-tree.txt
npm sbom --sbom-format cyclonedx > artifacts/qualification/sbom.cdx.json
npm audit --omit=dev --json > artifacts/qualification/npm-audit.json
```