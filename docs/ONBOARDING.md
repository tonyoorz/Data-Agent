# Vizion Lab Onboarding

## 项目概览

Vizion Lab 是一个本地全栈质量分析工作台，不是单一前端项目。它把三类能力放在同一个仓库里：

- React + Vite 前端界面
- Node 本地网关与 AI/duplicate-search 中转层
- Python analytics 与离线数据处理链路

对新成员来说，最重要的认识是：这个系统的价值不只在页面，而在于“页面 + 本地服务 + 数据分析”三层协同。

## 一句话架构

前端负责展示和交互，Node 层负责把 AI、duplicate search 和本地 API 组织起来，Python 层负责 analytics 查询与数据刷新，底层数据主要落在 SQLite。

## 推荐讲解顺序

1. 先讲怎么启动
   `npm run dev` 会同时拉起三个进程：
   - Vite 前端
   - Node 本地 API
   - FastAPI analytics

2. 再讲用户看到的两条主链路
   - Main Dashboard：面向质量分析与看板查看
   - AI Chat：面向缺陷检索、上下文增强和智能问答

3. 最后讲数据怎么流动
   - 前端发请求
   - Node 或 FastAPI 接住请求
   - Python analytics / duplicate search 访问 SQLite
   - 返回聚合结果给前端

## 关键目录

- `src/`
  前端应用主体。先看 `src/App.tsx` 和 `src/pages/Index.tsx`，再看 dashboard 页面。

- `server/`
  Node 网关。这里是 AI Chat、duplicate search、warmup、SSE 流式返回的组织中心。

- `backend/analytics/`
  FastAPI analytics 服务与读模型逻辑，负责 dashboard 查询。

- `backend/analytics_cli.py`
  离线运维入口，负责 refresh、backfill、archive 等数据处理任务。

- `scripts/duplicate_search_bridge.py`
  Python duplicate search 桥接进程，是 AI 上下文召回的重要组成部分。

- `database/`
  数据分层目录：
  - `source/`：原始或 staged 数据
  - `hot/`：面向 dashboard 的派生结果
  - `cold/`：归档数据

## 新成员建议阅读路径

### 第一阶段：先建立地图

建议先读这 3 个文件：

- `README.md`
- `package.json`
- `scripts/dev.mjs`

目标不是记参数，而是回答两个问题：

- 这个系统怎么启动
- 为什么它需要三个进程一起工作

### 第二阶段：理解前端入口

接着看：

- `src/App.tsx`
- `src/pages/Index.tsx`
- `src/components/dashboard/pages/MainDashboard.tsx`
- `src/components/dashboard/pages/AIChat.tsx`

这里要搞清楚：

- 用户进入系统先看到什么
- 哪些页面代表核心价值
- Main Dashboard 和 AI Chat 分别对应哪条业务链路

### 第三阶段：理解服务拼装

再看：

- `server/index.mjs`
- `server/aiContext.mjs`
- `server/companyChat.mjs`

重点理解：

- Node 网关为什么存在
- AI Chat 请求为什么不直接从前端打到 Python
- 上下文检索与 SSE 流式输出是怎么被串起来的

### 第四阶段：理解数据侧

最后看：

- `backend/analytics/api.py`
- `backend/analytics/read_models.py`
- `backend/analytics_cli.py`
- `scripts/duplicate_search_bridge.py`

重点理解：

- analytics 查询与离线刷新为什么要分开
- duplicate search 为什么要用独立 Python bridge
- source/hot/cold 三层数据分别解决什么问题

## 建议你给团队这样讲

“Vizion Lab 不是一个普通前端项目。它本质上是一个本地全栈分析工作台。前端负责把分析结果和 AI 交互呈现出来，Node 负责把实时交互能力组织起来，Python 负责 analytics 和检索能力，SQLite 则承载 source 与 serving 数据。理解这个项目，关键不是从组件细节开始，而是先看三层架构和主数据流。”

## 复杂度热点

新成员第一次接触时，优先提醒这几块：

- `MainDashboard.tsx`
  页面复杂度高，承载的业务状态和展示逻辑较多。

- `AIChat.tsx`
  同时涉及对话、duplicate search、warmup、上下文与流式消息。

- `server/index.mjs`
  是系统编排中枢，接口多、职责重。

- `backend/analytics/read_models.py`
  读模型复杂，直接决定 dashboard 返回结构。

- `backend/analytics_cli.py`
  入口集中，命令多，容易把“查询链路”和“运维链路”混在一起看。

## Agent 运行与权限

AI Chat 的生产路径不是把浏览器传来的 scope 直接交给工具。Node 网关会先解析 OIDC bearer token，再按服务器配置的 subject/group grant 生成 actor scope。随后：

1. LangGraph 根据 intent 选择紧凑工具集。
2. agent-only 缺陷 aggregate/records 请求携带短期签名 actor capability。
3. FastAPI 校验 capability，强制 team/project 行范围，并把 drilldown 绑定到 actor scope。
4. 语义查询继续使用 Ontology scope、敏感字段和 source revision 校验。
5. 最终回答带 evidence/citation contract；stream 完成后记录脱敏的 runtime summary。

`npm run dev` 会先读取 `.env`/`.env.local`；当 `VIZION_AGENT_AUTH_MODE` 未设置时才使用 `internal`，并为 Node/FastAPI 子进程生成同一个进程内 capability secret，同时默认缺陷行范围为 `DTSV_China`，为本地 Agent Operations 页面授予只读 `agent.operations.read` policy。配置任一 `VIZION_INTERNAL_TEAM_IDS`、`VIZION_INTERNAL_PROJECT_IDS` 或 `VIZION_INTERNAL_WORKSPACE_IDS` 即可覆盖默认范围；配置 `VIZION_INTERNAL_ROW_POLICY_IDS` 可覆盖本地 operator policy。Node 与 FastAPI 分开启动时，必须在 `.env.local` 中为两者配置同一个 `VIZION_AGENT_ACTOR_CAPABILITY_SECRET`、显式的 `VIZION_INTERNAL_*` 行范围和所需 row policy。显式配置的 `oidc` 不会被覆盖，`npm start` 仍默认使用 fail-closed 的 `oidc`。共享环境使用 `oidc`，需要 `VIZION_OIDC_ISSUER`、`VIZION_OIDC_AUDIENCE`、`VIZION_OIDC_JWKS_URI`、`VIZION_AGENT_OIDC_SCOPE_POLICY_JSON` 和 `VIZION_AGENT_ACTOR_CAPABILITY_SECRET`。不要把 capability secret 或 OIDC policy 放到前端环境变量。

Agent Operations 是受限页面，只有 scope 中带 `rowPolicyIds: ["agent.operations.read"]` 的 server-resolved actor 可读取。页面只显示 opaque run reference、意图、结果、恢复、证据和 citation 状态，不显示 raw prompt、ticket/person 数据、tool input/output 或 actor ID。

当前 duplicate search 和 legacy analytics fallback 还没有完整行级 scope enforcement。因此在 `oidc` 模式下，Node 会安全拒绝相关 direct routes 和 agent tools；它们仅供 `internal` trusted deployment 使用，直到 scoped retrieval 实现完成。

## 上线前资格验证

在非生产数据快照上连续执行两次下列检查。两次都通过才允许开启 shared-agent 流量：

```powershell
npm run test:agent-evals
.\.venv\Scripts\python.exe -m pytest backend\tests\test_agent_actor_capability.py backend\tests\test_analytics_full_picture_api.py backend\tests\test_semantic_query_api.py -q
npm run build
```

记录每次的 scorecard case 数、通过率、P50/P95 latency、tool failure/denial rate、citation pass/blocked 数和 operations summary。若需要紧急回退，先在代理层关闭 AI/agent-operations 路由，保留 dashboard analytics 路由，再排查资格检查失败原因。

## 本地演示建议

如果你要给团队做 5 分钟介绍，建议按下面顺序：

1. 先打开架构图，讲三层结构
2. 再点前端主页面相关节点，讲用户入口
3. 再点 Node 网关相关节点，讲 AI 与 duplicate search 的组织方式
4. 最后点 analytics 与数据库节点，讲数据如何准备、如何服务 dashboard

这样讲的好处是，听众先有地图，再进入代码，不容易在细节里迷路。
