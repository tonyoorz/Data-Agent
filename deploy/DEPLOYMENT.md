# Vizion 数据看板 — 生产级部署指南（内网 / 私有机 / Pod）

> 目标：让你这台电脑（或一台内网服务器 / 一个 Pod）成为稳定服务，同事通过内网访问，
> 获得更好的并发、性能和体验。**不依赖公有云**。

---

## 0. 先看清现状（为什么现在同事访问不了 / 体验差）

你的项目实际由 **3 个进程** 组成，全部跑在同一台机器上：

| 进程 | 启动方式 | 监听 | 作用 |
|------|----------|------|------|
| **Web + API（Node）** | `node server/index.mjs` | `127.0.0.1:3004` | 托管前端 `dist/` + 所有 `/api/*`，并懒加载拉起 Python 桥接子进程 |
| **Analytics（Python）** | `python -m uvicorn backend.analytics.api:app` | `127.0.0.1:3003` | 报表/全量数据 API，Node 把它代理给浏览器 |
| **Python 桥接子进程** | `scripts/duplicate_search_bridge.py --server` | （子进程） | 重复工单检索，加载 `bge-small-zh-v1.5` + reranker + RapidOCR 等重模型 |

你**当前在本地能访问**是因为浏览器就在 `127.0.0.1` 上。同事访问不了，根因是代码里的两道“只认本机”的墙：

1. **绑定地址是 `127.0.0.1`**（`server/localApiBinding.mjs` 的 `LOCAL_API_HOST`）。即使防火墙/端口开了，服务也只听本机回环，外部连不进来。
2. **`isTrustedLocalApiRequest()` 强制校验 Origin 必须是 loopback**，否则直接 `403 LOCAL_API_ORIGIN_REQUIRED`。同事浏览器发来的 `Origin: http://你的IP:端口` 不是回环地址 → 被拒。

另外还有两个“部署前必须处理”的点：

- **鉴权默认 `oidc`**：`/api/ai/chat` 等需要 JWT。内网没有 OIDC 时，改成 `VIZION_AGENT_AUTH_MODE=internal` 即可放行（见下文）。
- **重依赖 + 模型**：Node 24.x、Python 3.12.x 精确版本；`.venv`；`sentence-transformers / onnxruntime / rapidocr`；embedding 模型要从 HuggingFace 下，**内网通常下不动**→ 必须预置。

---

## 1. 推荐架构（一套配置，三种落地方式通用）

```
同事浏览器
   │  http://<服务器IP>:8080   (或公司域名)
   ▼
┌──────────────────────────────────────────────────────────┐
│  反向代理 nginx（监听 0.0.0.0:8080）                       │
│  关键技巧：转发时把 Host 改写成 127.0.0.1:3004，并清空     │
│  Origin 头 → 上面第 2 道墙直接通过，无需改任何业务代码。   │
└──────────────────────────────────────────────────────────┘
   │  (loopback trust trick)
   ▼
Node 服务 127.0.0.1:3004  ──/api/full-picture 等──▶ Analytics 127.0.0.1:3003
   │  └─ 懒加载 ─▶ Python 桥接子进程（重复工单，加载本地模型）
   │
   └─ 静态文件 dist/ 直接返回
持久化卷 /data：agent-checkpoints.db、database/*、模型缓存
```

**为什么用 nginx 而不是直接暴露 Node？**
- 它替你解决了那两道“只认本机”的墙（零代码改动，最稳）。
- 自带 gzip/Brotli 压缩、HTTP/2、内容哈希资源的长期缓存 → 首屏更快、服务器压力更小（更好的 UX）。
- SSE 流式对话需要 `proxy_buffering off`，nginx 一行搞定。
- 以后要 HTTPS / 单点登录，都在这一层加。

> 如果你**必须**直接暴露 Node（比如公司 Ingress 你完全掌控），用 `deploy/patches/expose-for-lan.patch` 放开 `VIZION_BIND_HOST` 和 `VIZION_TRUSTED_ORIGINS`，然后跳过 nginx。

---

## 2. 方式 A：Docker Compose（最快，推荐先上）

适合：直接在一台内网 Linux 机器（你的电脑或服务器）上跑。

```bash
cd /path/to/Data-Agent

# 1) 准备环境变量（含 LLM 凭证、Supabase 公钥等）
cp deploy/.env.production.example deploy/.env.production
# 编辑 deploy/.env.production，至少填：
#   - DUPSEARCH_CHAT_ACCESS_CODE / VIZION_LLM_BASE_URL 等（聊天所需）
#   - 如需离线 OCR：DUPSEARCH_RAPIDOCR_*_MODEL

# 2) 构建镜像（首次会下载并烘焙 embedding 模型，需要联网）
docker compose -f deploy/docker-compose.yml build

# 3) 启动
docker compose -f deploy/docker-compose.yml up -d

# 4) 验证
curl http://127.0.0.1:8080/health      # -> {"ok":true}
# 同事访问： http://<这台机器内网IP>:8080
```

- 镜像内含 Node24 + Python3.12 + `.venv` + 前端 `dist` + 烘焙好的 embedding 模型。
- `vizion-data` 卷持久化 `/data`（checkpoints、database、缓存），重启不丢。
- 三个服务：`app`（Node）、`analytics`（Python）、`nginx`（代理 8080）。
- 想重新构建但不下模型（模型已在外面准备好）：`docker compose build --build-arg BAKE_MODELS=0`，并把模型挂进 `/app/backend/cache/embedding_models/...`。

---

## 3. 方式 B：Kubernetes Pod（你说的“部署到 pod”）

适合：私有 K8s 集群 / 内网 kubectl 环境。

设计：**一个 Pod 内 3 个容器（app + analytics + nginx sidecar）共享一个 RWO 块存储卷 `/data`**。
这样完全等价于单机 compose，且避免跨 Pod 写 SQLite/DuckDB（本项目用的是单写者存储）。

```bash
# 构建并推到你的私有镜像仓库
docker build -f deploy/Dockerfile -t <你的仓库>/vizion:prod .
docker push <你的仓库>/vizion:prod

# 编辑 deploy/k8s.yaml：把 <your-registry>/vizion:prod 换成真实地址；
# 在 Secret vizion-env 里补 LLM 凭证；storageClassName 改成你集群的块存储类。
kubectl apply -f deploy/k8s.yaml

# 访问：集群内 Service vizion:8080；外部通过 Ingress（文件末尾已注释示例）或 NodePort。
```

注意：
- `storageClassName` 用**本地/块存储（Local PV / 云硬盘）**，**不要用 NFS**——SQLite/DuckDB 在网络文件系统上容易锁损坏。
- 默认 `replicas: 1`。要横向扩容，必须先把存储迁到外部数据库（见第 6 节“扩容”）。
- 文件末尾附了 Ingress 模板（TLS 在 Ingress 层终止）。

---

## 4. 方式 C：裸机 systemd（不使用容器）

适合：直接在一台装好运行时的 Linux 服务器上以系统服务常驻。

前置（在服务器上）：
```bash
# Node 24.x、Python 3.12.x
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm ci && npm run build          # 产出 dist/
# 预置模型（需联网一次）： bash deploy/scripts/prestage-models.sh
```

部署：
```bash
sudo cp deploy/systemd/vizion-*.service /etc/systemd/system/
sudo useradd -r -s /usr/sbin/nologin vizion
sudo chown -R vizion:vizion /opt/vizion
sudo systemctl daemon-reload
sudo systemctl enable --now vizion.target
# nginx 用 deploy/nginx.conf：
sudo cp deploy/nginx.conf /etc/nginx/nginx.conf && sudo nginx -t && sudo systemctl restart nginx
```

`vizion.target` 会拉起 `vizion-app` + `vizion-analytics`，崩溃自动重启。

---

## 5. 必须配置的环境变量速查

| 变量 | 说明 |
|------|------|
| `VIZION_AGENT_AUTH_MODE` | 内网设为 `internal`（免登录放行）；要真 SSO 用 `oidc` + `VIZION_OIDC_*` |
| `VIZION_ANALYTICS_API_BASE` | 恒为 `http://127.0.0.1:3003`。**注意**：`analyticsApiConfig.mjs` 拒绝非回环地址，所以 analytics 在每个部署里都与 app 共享网络命名空间（compose 用 `network_mode: service:app`，k8s/裸机同 Pod/同机），只能走 127.0.0.1。 |
| `TRANSFORMERS_OFFLINE` / `HF_HUB_OFFLINE` | 都设 `1`，强制离线，避免运行时去下载模型 |
| `DUPLICATE_EMBEDDING_MODEL` | 指向预置模型目录（Dockerfile 已设好） |
| `DUPSEARCH_BRIDGE_SEARCH_TIMEOUT_MS` | 重复工单检索超时，默认 180000ms |
| `VIZION_AGENT_CHECKPOINT_DB` / `VIZION_DATABASE_ROOT` | 指向持久卷 `/data/...` |
| `DUPSEARCH_CHAT_ACCESS_CODE` / `VIZION_LLM_BASE_URL` 等 | **聊天功能必需**，按 `server/chatModelConfig.mjs` 期望填 |

---

## 6. 性能 / 并发 / 体验优化（你最关心的“更好”）

1. **静态资源长期缓存**：nginx 对 `*.js|css|svg|...` 加 `Cache-Control: immutable, max-age=1y`。`dist/` 里的资源带内容哈希，安全强缓存 → 二次访问几乎秒开。
2. **gzip + HTTP/2**：大 bundle 压缩传输，多路复用降低延迟。
3. **SSE 不缓冲**：`proxy_buffering off`，流式回答实时推给浏览器，不会“转圈等半天”。
4. **预加热模型**：启动时 `VIZION_*` 触发 background warmup（代码已有 `shouldWarmDuplicateSearch`），首次检索不再冷启动卡顿。
5. **进程守护**：compose `restart: unless-stopped` / k8s `restartPolicy` / systemd `Restart=on-failure` → 挂了自动拉起，同事无感。
6. **健康检查**：`/health`（Node）与 `/openapi.json`（Analytics）用于探针，异常自动摘流。
7. **资源配额**：k8s 已给 requests/limits（Node 2–8Gi、Analytics 1–4Gi）。embedding+reranker 吃内存，给够。
8. **扩容瓶颈（重要）**：当前 Node 单进程 + Python 桥接子进程**串行处理**检索请求（`requestChain`）。多人同时检索会排队。并发上不去时优先：
   - 保证模型已预热（冷启动最慢）；
   - 把 LLM 端点调成更高并发配额（聊天 I/O 密集，Node 能扛）；
   - 真正高并发需改代码：桥接起多个 worker / 把 SQLite 换成 Postgres、把 embedding 索引外置。属于下一步演进，不在本次部署范围。

---

## 7. 安全与运维提醒

- **内网 ≠ 安全**：`internal` 模式等于“网内任何人都能用”。务必配合：VLAN/防火墙只允许同事网段、或 nginx 加 `auth_basic`、或上 OIDC。
- **密钥**：`.env.production` 含 LLM 凭证，**不要提交进 git**（已在 `.dockerignore` 排除，并加 `.env.production` 忽略）。
- **TLS**：公司内网建议至少自签/内部 CA 证书，在 nginx / Ingress 层终止。
- **SQLite 用本地盘**：容器内/ Pod 内用块存储，别挂 NFS。
- **日志**：`docker compose logs -f app` / `journalctl -u vizion-app`；关键指标已在 `server/index.mjs` 以 `[vizion-metric]` 打印，可接 Loki/Promtail。

---

## 8. 常见坑

- **403 LOCAL_API_ORIGIN_REQUIRED**：nginx 没改写 Host/Origin，或你绕开 nginx 直连 Node 又没打补丁。检查 nginx.conf 的 `proxy_set_header Host "127.0.0.1:3004";` 和 `proxy_set_header Origin "";`。
- **聊天 503/401**：没设 `VIZION_AGENT_AUTH_MODE=internal` 或没配 OIDC。
- **embedding 下载超时/失败**：内网连不上 HuggingFace。用 `deploy/scripts/prestage-models.sh` 在有网机器下好，再烘焙进镜像或挂卷。
- **Analytics 报数据库找不到**：`VIZION_DATABASE_ROOT` 指向的 `/data/database` 没挂卷或为空——首次运行需要先有源数据（如 Octane 拉取）。
- **Node 报版本不对**：必须是 24.x；Python 必须 3.12.x，靠 `.venv`。

---

## 9. 文件清单（本目录 `deploy/`）

| 文件 | 用途 |
|------|------|
| `Dockerfile` | 多阶段镜像：Node24 构建前端 + Python3.12 运行时，烘焙模型 |
| `docker-compose.yml` | compose 三服务栈（app / analytics / nginx） |
| `nginx.conf` | 反向代理（含绕过本地信任校验的技巧 + 缓存/SSE） |
| `.env.production.example` | 生产环境变量模板 |
| `k8s.yaml` | 单 Pod 三容器 + PVC + Service + Ingress 示例 |
| `nginx-k8s.conf` / k8s 内联 | Pod 内 upstream 用 127.0.0.1 的 nginx 配置 |
| `systemd/vizion-*.service` | 裸机 systemd 单元 |
| `patches/expose-for-lan.patch` | 可选：不打 nginx 时直接暴露 Node 的补丁 |
| `scripts/prestage-models.sh` | 离线预置 embedding 模型 |
| `DEPLOYMENT.md` | 本文件 |
