## 目标
让 AI Chat 对标 ChatGPT / Claude Agent 的体验，并和 DTSV 仪表盘的数据上下文打通。
你选了 12 项功能，一次性实现会让 PR 体量过大、难以验收，建议分两期。

---

## 第一期（本轮直接实现，约 10 项变更）

### 1. 后端 / 数据
- 新增数据库表
  - `conversations(id, user_id, title, pinned, model, created_at, updated_at)`
  - `messages(id, conversation_id, role, content, parts jsonb, created_at)`
  - `parts` 用 jsonb 存 `tool_call / reasoning / citation / attachment` 等结构化片段
- 启用 Storage bucket `chat-uploads`（私有），用于文件 / 图片上传
- 启用最简邮箱密码登录（持久化必须有用户身份）
- RLS：用户只能读写自己的会话

### 2. 输入框增强
- 文件 / 图片上传按钮（拖拽 + 粘贴 + 点击）—— 上传到 `chat-uploads`，气泡里以缩略卡展示
- Slash 命令面板：`/` 触发，预置 `/分析覆盖率` `/缺陷周报` `/Top Issue 诊断` `/解释这张图` 等
- 语音输入按钮：MediaRecorder 录制 → 上传到边缘函数 `transcribe` → Lovable AI Gemini 转写
- 上下文 chips：自动把当前侧栏所在的分析模块 + 已选筛选条件附在 prompt 前

### 3. 流式输出增强
边缘函数 `chat` 升级为 SSE 多事件类型：
- `delta` 文本片段
- `reasoning` 思考过程（折叠面板，灰色，可展开 / 隐藏）
- `tool_call` 工具调用步骤（"正在查询缺陷表…" 带 loading → 完成态 + 结果摘要）
- `citation` 数据来源 chip（指向具体表 / 图表 ID）
- 客户端按事件类型渲染不同 UI 块

### 4. 消息操作
每条 assistant 消息悬浮工具栏：复制、重新生成、点赞 / 点踩；user 消息：编辑后重发（截断后续）

### 5. 会话管理
- 持久化历史（替换当前 in-memory 状态）
- 列表右键 / 三点菜单：重命名、删除、置顶
- 自动生成会话标题（首轮消息后调用 AI 一次性总结成 6-12 字标题）

### 6. 渲染增强
- 代码块：语法高亮（`react-syntax-highlighter`）+ 一键复制
- Mermaid 图表渲染
- 数学公式 KaTeX
- 表格美化（已有 GFM，补样式）

---

## 第二期（确认第一期可用后再做）
- 分享：生成只读链接 `/share/:token`
- 导出：当前会话导出 Markdown / PDF
- 多 Agent 协作（如果你 testagent 有这部分需求）
- 引用 chip 点击跳转到对应仪表盘视图并自动应用筛选

---

## 技术细节（给你参考，可跳过）

- 流式协议保持 OpenAI 兼容 SSE，自定义事件用 `data: {"type":"reasoning|tool_call|citation|delta", ...}` 包装
- Slash 命令是纯前端字典 + Cmd-K 风格 popover（用 `cmdk`）
- 语音转写走 Lovable AI `google/gemini-2.5-flash` 的多模态输入，避免新外部依赖
- 上下文注入：`Index.tsx` 把 `activeNav + filters` 写入 React Context，`AIChat` 读取后在 system message 前置一段 "用户当前在 X 模块，筛选条件 Y"
- 持久化采用乐观更新：先 setState，再 upsert，错了回滚

---

## 我需要你确认两点
1. **是否同意分两期**？（一期已经接近一个完整 PR，再加分享 / 导出会很难一次性 review）
2. **是否启用邮箱密码登录**？持久化必须有用户身份，没有登录就没法 RLS。
   - 同意 → 我加最简单的登录页（邮箱 + 密码 + 一键 demo 账户）
   - 不同意 → 第一期跳过持久化，先做 UI 增强（工具调用可视化 / Slash / 文件上传 / 语音 / 引用 / 消息操作），用 localStorage 暂存
