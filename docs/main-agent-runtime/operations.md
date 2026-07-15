# Main Agent Runtime Operations

Phase 1 is a local SQLite Runtime behind `MAIN_AGENT_RUNTIME_MODE=legacy|shadow|langgraph`. Development identity is loopback-only; LAN exposure requires trusted proxy identity, TLS termination, and an explicit origin allowlist.

Operational commands:

```bash
npm run agent:runtime:migrate -- --db-path database/runtime/runtime.sqlite
npm run agent:runtime:check -- --db-path database/runtime/runtime.sqlite
npm run eval:agent:smoke -- --mode langgraph --model fake-certified --repeat 3 --fallback off --output artifacts/qualification/pr-smoke.json
npm run load:agent-runtime -- --base-url http://127.0.0.1:3004 --output artifacts/qualification/load.json
npm run agent:runtime:cleanup -- --db-path database/runtime/runtime.sqlite --dry-run --manifest artifacts/qualification/cleanup.json
```

Rollback is `MAIN_AGENT_RUNTIME_MODE=legacy` followed by a Node restart. Duplicate Search remains independent of this flag. Phase 1 does not enable Octane writes, approval decisions, Python Ontology grounding, or test-case draft generation.