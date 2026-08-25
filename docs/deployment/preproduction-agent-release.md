# Governed Data Agent Pre-production Release Runbook

This runbook turns a qualified repository commit into a controlled pre-production release. A deterministic qualification pass is necessary, but it is not evidence that production data, identity mapping, latency, or business accuracy are correct.

## 1. Release topology and route ownership

Use one governed LangGraph Agent path and a colocated authenticated gateway:

```text
browser -> authenticated gateway -> Node API/static build
                              \----> private dashboard routes on FastAPI
Node Agent ------------------------> agent-only FastAPI routes
```

The gateway must be on the same host, pod, or trusted sidecar boundary as the loopback Node listener. It authenticates the external request, validates the public Origin, preserves the bearer token for Node auth, rewrites the upstream Host to the exact loopback Node host/port, and removes the already-validated browser Origin before forwarding. Node and FastAPI must not otherwise be reachable from the client network.

Do not send all `/api/*` traffic to one upstream. Configure this explicit route matrix:

| External route | Upstream | Required control |
| --- | --- | --- |
| `/`, built assets, SPA routes | Node | Auth policy chosen for the dashboard. |
| `/api/ai/chat`, `/api/chat`, `/api/ai/transcribe`, `/api/agent-operations/*` | Node loopback | Gateway auth plus Node OIDC/scope enforcement. |
| Approved dashboard reads under `/api/full-picture/*`, `/api/testing/*`, `/api/metadata/*`, `/api/correlation/*` | Private FastAPI | Disabled for a multi-scope Agent canary unless the backend is scope-aware; otherwise restrict to one homogeneous group already authorized for the complete dashboard dataset. Agent RLS does not cover these routes. |
| `/api/qgate-reports/latest-dashboard`, `/api/qgate-reports/weekly-report`, `/api/qgate-reports/dashboard-html` | Node loopback | Exact allowlist plus gateway auth; Node serves local reports or proxies the configured analytics origin. |
| `/api/semantic/*`, `/api/agent/analytics/*`, actor-capability endpoints | No public route | Node-to-FastAPI only, protected by the signed actor capability. |
| `/api/duplicate-search*`, `/api/duplicate-feedback`, `/api/ai/context` | No shared-environment route | Internal-only until retrieval has complete row-scope and evidence enforcement. |
| `/health` | Internal probe only | Do not use it as a public authentication bypass. |
| Every other `/api/*` route | Deny | Default-deny, including browser access to `/api/analytics/*` and `/api/ontology/*`. |

- Keep FastAPI on loopback or a private service network. Browsers must never call its agent-only routes directly.
- Set `VIZION_ANALYTICS_API_BASE` when FastAPI is not on the Node host. Non-loopback origins must use HTTPS; use mTLS or an encrypted service mesh where required. Plain HTTP is accepted only for exact loopback hosts. The origin cannot contain credentials, path, query, or fragment.
- Do not run the Vite development server as shared ingress. It binds to `127.0.0.1` by default; remote development also requires an authenticated gateway.
- GraphPathfinder is discovery-only. A reachable Ontology path is not executable unless a runtime relationship contract publishes join keys, direction, metric grain, cardinality/fanout handling, actor-scope propagation, source revision compatibility, and an executor adapter.

## 2. Immutable release candidate

From a clean checkout of the exact candidate commit, use Node 24 and one explicit Python interpreter:

```bash
test -z "$(git status --porcelain)"
git rev-parse HEAD
node --version
/absolute/path/to/python --version
npm ci
npm audit --audit-level=high

npm run ontology:check
npm run test:agent-evals
npm test
/absolute/path/to/python -m pytest -q
npm run build
npm run lint
git diff --check
```

Restore any test-generated database changes before qualification. Then create and verify the commit-bound artifact:

```bash
npm run agent:qualification -- --full --build
npm run agent:qualification:verify
test -z "$(git status --porcelain)"
```

Schema `1.2` qualification records Node 24 compatibility, the candidate-local `package-lock.json` SHA-256, lock integrity metadata, Vite/Vitest package and entrypoint hashes, and a canonical hash of the installed dependency tree; with `--build`, it also records every `dist` file hash plus a canonical build tree hash. Qualification requires every non-optional locked package and direct dependency to exist locally at the locked version, rejects checkout-external package/symlink paths, and detects installed-tree mutation during or after qualification. Run it only after a fresh `npm ci` in the exact isolated candidate checkout or release image. The recorded npm integrity strings are lock metadata, not an independent reconstruction of registry tarballs, so the immutable build environment and image digest remain part of release provenance. The repository's verification command requires the release profile (`full_node_tests` and `production_build`); a minimal development artifact is not release-verifiable. Record the commit SHA, Ontology fingerprint, qualification payload SHA-256, build/dependency tree SHA-256 values, fixture counts, Node/Python versions, dependency metadata, image digest, and command results in the release record. The artifact is deterministic fixture evidence, not a production snapshot.

Python dependencies are currently range-based rather than lockfile-complete. Build one immutable Python image/environment, record its image digest and `python -m pip freeze --all` SHA-256, run Pytest with that exact interpreter, and deploy the same digest. Do not treat the Git commit alone as Python-environment provenance.

## 3. Server-owned configuration

Inject server configuration through the deployment secret/configuration system. Never put server secrets or scope policy in `VITE_*` variables, browser storage, source control, model prompts, or release artifacts.

| Variable | Requirement |
| --- | --- |
| `VIZION_AGENT_AUTH_MODE` | Must be `oidc` for shared or production traffic. |
| `VIZION_OIDC_ISSUER` | HTTPS issuer that exactly matches verified tokens. |
| `VIZION_OIDC_AUDIENCE` | Dedicated audience for this service. |
| `VIZION_OIDC_JWKS_URI` | HTTPS JWKS endpoint. |
| `VIZION_AGENT_OIDC_SCOPE_POLICY_JSON` | Server-owned subject/group grants; no wildcard object type or ambiguous multi-grant union. |
| `VIZION_AGENT_ACTOR_CAPABILITY_SECRET` | High-entropy Node-to-FastAPI secret, supplied identically to both services. |
| `VIZION_ANALYTICS_API_BASE` | Private HTTPS FastAPI origin for split deployment. It overrides the loopback `VIZION_ANALYTICS_PORT` default. |
| `VIZION_ANALYTICS_PROXY_TIMEOUT_MS` | Finite analytics deadline, default 10 seconds and maximum 120 seconds. |
| `VIZION_AGENT_RUNTIME_STORE_DIR` | Encrypted, access-controlled persistent location with retention configured. |
| `VIZION_ONTOLOGY_ROOT`, `VIZION_ONTOLOGY_FINGERPRINT` | Exact qualified Ontology bundle and expected fingerprint. |
| `VIZION_DATABASE_ROOT` or explicit `VIZION_FULL_PICTURE_*_DB_PATH`, `VIZION_ANALYTICS_DB_PATH`, `VIZION_SEMANTIC_ANALYSIS_DB_PATH` | Mounted source/read-model/semantic stores for this release. |
| `DUPSEARCH_CHAT_ACCESS_CODE`, or `DUPSEARCH_CHAT_API_KEY` plus `DUPSEARCH_CHAT_API_BASE` | Least-privilege model provider credential and endpoint. |
| `DUPSEARCH_CHAT_MODEL_OPTIONS` and build-time `VITE_DUPSEARCH_CHAT_MODEL_OPTIONS` | Identical strict server/UI model allowlist; an explicit list replaces repository defaults. |
| `DUPSEARCH_TRANSCRIBE_PROVIDER=company` plus `DUPSEARCH_TRANSCRIBE_ACCESS_CODE`, or `=remote` plus `DUPSEARCH_TRANSCRIBE_URL` and `DUPSEARCH_TRANSCRIBE_API_KEY` | Explicit ASR provider and dedicated credential. Credentials alone never select a provider; chat credentials are never reused. |
| `DUPSEARCH_TRANSCRIBE_TIMEOUT_MS` | Finite remote ASR deadline, default 60 seconds and maximum 300 seconds. |
| `DUPSEARCH_OCR_PROVIDER=remote`, `DUPSEARCH_OCR_URL`, `DUPSEARCH_OCR_API_KEY` | Optional remote OCR contract. Input must be a validated image data URL; remote origin must be HTTPS, cannot redirect, and never receives a client filesystem path. |
| `DUPSEARCH_OCR_TIMEOUT_MS` | Finite remote OCR deadline, default 60 seconds and maximum 300 seconds. |

Use `VIZION_ANALYTICS_PORT` for any colocated loopback topology. Configuration precedence is `VIZION_ANALYTICS_API_BASE`, then `VIZION_ANALYTICS_PORT`, then `http://127.0.0.1:3003`. Invalid analytics origins/timeouts fail during Node startup. Remote model and ASR origins must also use HTTPS and reject URL credentials, query parameters, and fragments. Generic `API_KEY` is not accepted as a model credential; ASR never falls back to chat/model secrets.

Build the immutable frontend with only the public `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` values. The current UI consumes and refreshes an existing Supabase session; it does not implement the sign-in/code-exchange bootstrap. Pre-production is blocked until the hosting shell or an approved UI flow supplies login, redirect, refresh, logout, and session revocation. Verified access tokens must contain a non-empty string `sub`; group policy matching requires a string-array `groups` claim. Test JWKS rotation, clock synchronization, group removal/token expiry, and subject-plus-group ambiguous-match denial.

Configure `VIZION_API_PORT`, `VIZION_WEB_PORT`, and the finite `VIZION_API_JSON_BODY_LIMIT_BYTES` at the Node boundary. Configure answer-buffer limits and provider/bridge timeouts only when their features are enabled. Configure cold database/Parquet, Octane, OCR, ASR, PDF, and duplicate-search variables only for adapters included in the release; unused adapters must remain unreachable.

Node loads repository `.env`/`.env.local`, but a separately started FastAPI process does not. Shared deployments must inject the capability secret, Ontology/data paths, and other shared settings into both services through the same deployment configuration—not through an accidental checkout-local file. The local launcher gives Vite, the persistent FastAPI service, analytics CLI/ingest jobs, and local Python media workers separate consumer-specific environments; PIN/cookie/Octane refresh credentials belong only to the CLI/ingest job, while Node OIDC policy and model secrets belong to neither Python process. Production supervisors must preserve these per-process allowlists rather than inject one global secret set.

Before accepting traffic, verify that every OIDC grant has an owner, version/hash, expiry/review date, allowed object types, row scope, sensitive-field policy, and—where needed—`agent.operations.read`. Duplicate search and legacy fallback remain unavailable to OIDC actors until their retrieval paths enforce the same scope and evidence contract.

## 4. Start and network checks

Deploy the already qualified commit and its prebuilt `dist`; do not rebuild inside the runtime checkout. Start FastAPI with the qualified Python environment and Node with Node 24. Do not use `npm run dev` in shared environments.

```bash
ANALYTICS_PORT="${VIZION_ANALYTICS_PORT:-3003}"
/absolute/path/to/python -m uvicorn backend.analytics.api:app \
  --host 127.0.0.1 --port "$ANALYTICS_PORT"

npm start
```

Run both processes as unprivileged service accounts under a supervisor with an exact release working directory, read-only code/dist mounts, writable owner-only runtime/data mounts, graceful `SIGTERM`, bounded restart policy, and structured log collection. Start FastAPI first, then Node, then enable gateway traffic only after live checks. Expose only gateway TLS port `443` to client networks. Set gateway per-actor rate/concurrency limits, SSE-compatible buffering/timeouts, the same finite body ceiling, and an egress allowlist for IdP/JWKS, model provider, and approved private services.

For a split private-network deployment, bind FastAPI only to its private interface, require HTTPS with mTLS or an encrypted service mesh, apply service-network policy, and set `VIZION_ANALYTICS_API_BASE` on Node. The gateway must explicitly implement the route matrix above; the Node static server is not a general FastAPI proxy. The two `/health` endpoints are liveness only and do not prove database, Ontology, JWKS, model, or scope readiness.

Run these boundary probes from the trusted service network, replacing ports when configured:

```bash
curl -fsS http://127.0.0.1:3003/health
curl -fsS -H 'Host: 127.0.0.1:3004' http://127.0.0.1:3004/health

curl -i -H 'Host: 127.0.0.1:3004' -H 'Content-Type: application/json' \
  --data '{"messages":[{"role":"user","content":"smoke"}]}' \
  http://127.0.0.1:3004/api/ai/chat
# Expect: 401 AUTHENTICATED_ACTOR_REQUIRED

curl -i -H 'Content-Type: application/json' --data '{}' \
  http://127.0.0.1:3003/api/semantic/query
# Expect: 401 ACTOR_CAPABILITY_MISSING

curl -i -H 'Host: attacker.example:3004' http://127.0.0.1:3004/health
# Expect: 403 LOCAL_API_ORIGIN_REQUIRED

curl -i -H 'Host: 127.0.0.1:3004' -H 'Origin: https://attacker.example' \
  http://127.0.0.1:3004/health
# Expect: 403 LOCAL_API_ORIGIN_REQUIRED
```

Run the gateway smoke with two real test actors from different scopes. Never put their bearer tokens in shell history, console output, or CI artifacts.

Verify all of the following before enabling the canary group:

1. Node and FastAPI health checks return `200` only through their intended network paths.
2. The browser/static endpoint is reachable through the authenticated gateway; neither Node nor FastAPI is reachable directly from the client network.
3. Missing/invalid bearer tokens return `401`; direct internal-only routes or missing grants return safe `403` denials. An authenticated semantic denial may keep HTTP `200 text/event-stream`; assert terminal `denied`/`blocked`, zero business data, and zero answer text.
4. Non-JSON API requests, untrusted Host/Origin values, and oversized request bodies return `415`, `403`, and `413` respectively.
5. One allowed aggregate query and its same-snapshot records continuation succeed with citations and the expected source revision.
6. The same client conversation ID under a second actor cannot read the first actor's checkpoint, evidence, records reference, or browser history.
7. A cross-scope query, missing actor capability, stale source revision, unmaterialized dimension, and unpublished graph relationship all fail closed before a provider or final-answer release.
8. Uncited ranking/concentration claims and unsupported causal claims release no answer text and produce machine-readable blocked outcomes.
9. Runtime files remain owner-only and contain no raw prompt, actor ID/scope, client run/thread ID, tool input/output, provider body, or stack.
10. Agent Operations reports `completed`, `blocked`, `denied`, and `failed` distinctly and can join events by opaque run reference.

Qualification does not inspect a running IdP, gateway, database, model, or secret mount. Use the live smoke above for deployed configuration. If deployment preparation changes code, Ontology, fixtures, or `dist`, create a new immutable commit and qualification artifact instead of reusing the old result.

## 5. Canary, observation, and rollback

Start with a least-privilege canary group. Compare request count, latency, tool failures, denials, evidence blocks, citation validation, source freshness warnings, and empty-result rate against the release thresholds. Review a sample of evidence-backed business answers against the same data snapshot; deterministic fixtures alone do not qualify business accuracy.

Before rollout, snapshot the immutable Node/Python artifacts, Ontology/runtime-capability fingerprint, OIDC policy hash, data/schema version, semantic-analysis store, and compatible runtime-store format. FastAPI startup can apply forward schema changes, so take an approved database snapshot and prove restore or forward-compatible rollback before starting the candidate. The current LangGraph `MemorySaver` is process-local: restart or rollback loses clarification/continuation checkpoint state. Drain active streams where possible and require users to start a new conversation; runtime audit files cannot restore graph execution.

Rollback is traffic-first and must never cross below the release's security floor for OIDC/RLS, actor-scoped storage, evidence release, or safe audit logging:

1. Disable `/api/ai/chat`, `/api/chat`, `/api/ai/transcribe`, `/api/agent-operations/*`, and all internal-only AI/duplicate routes at the gateway while keeping approved read-only dashboard routes available.
2. Preserve the failed release's sanitized audit artifacts according to the incident policy.
3. Restore the previous immutable Node/FastAPI pair and its compatible Ontology/runtime-capability bundle.
4. If rotating the actor-capability secret, stop new Agent traffic and restart Node and FastAPI together; a mixed secret version must remain fail-closed.
5. Re-run health, identity/scope, evidence-release, fixed-snapshot continuation, and live gateway smoke before restoring a small canary.

The candidate is eligible for a pre-production canary and production review only when the release record, IdP/scope-policy review, dashboard-authorization decision, private-network proof, canary evidence, rollback owner, and retention controls are all signed off.
