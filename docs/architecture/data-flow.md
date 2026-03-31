# Claude Code 数据流与模块关系

## 概述

本文档描述 Claude Code 中各子系统间的数据流向，包括用户输入处理、上下文构建、API 通信、工具执行、MCP 集成和费用追踪。

---

## 主数据流图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          完整数据流                                     │
│                                                                         │
│  Terminal Input                                                         │
│       │                                                                 │
│       ▼                                                                 │
│  PromptInput.tsx ──onSubmit──► processUserInput()                       │
│       │                            │                                    │
│       │                            ├── 斜杠命令处理 (/compact, /clear)  │
│       │                            ├── 引用展开 ([Pasted text #1])      │
│       │                            └── 权限检查                         │
│       │                                                                 │
│       ▼                                                                 │
│  QueryEngine.submitMessage()                                            │
│       │                                                                 │
│       ├── fetchSystemPromptParts()                                      │
│       │     ├── getSystemPrompt()     → 系统提示词                      │
│       │     ├── getUserContext()       → CLAUDE.md 内容                  │
│       │     └── getSystemContext()     → Git 状态信息                    │
│       │                                                                 │
│       ▼                                                                 │
│  query() async generator                                                │
│       │                                                                 │
│       ├── 压缩链: snip → microcompact → collapse → autocompact         │
│       │                                                                 │
│       ├── prependUserContext(messages, userContext)                      │
│       │     └── 将 CLAUDE.md 注入消息头部                               │
│       │                                                                 │
│       ├── appendSystemContext(systemPrompt, systemContext)               │
│       │     └── 将 Git 状态附加到 system prompt                         │
│       │                                                                 │
│       ▼                                                                 │
│  deps.callModel() ──► Anthropic API (流式)                              │
│       │                                                                 │
│       ├── StreamEvent (思考、文本、工具调用)                             │
│       │                                                                 │
│       ▼                                                                 │
│  StreamingToolExecutor / runTools()                                      │
│       │                                                                 │
│       ├── canUseTool() ──► 权限检查                                     │
│       ├── tool.call()  ──► 工具执行                                     │
│       └── tool result  ──► 消息                                         │
│                                                                         │
│       ▼                                                                 │
│  yield 事件 ──► REPL.tsx ──► Ink Renderer ──► Terminal Output           │
│                                                                         │
│  if (有工具调用) → 继续循环                                              │
│  else → 返回终止                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 用户输入流 (Input Flow)

```
Terminal (stdin)
    │
    ▼
PromptInput.tsx
    │  - 键盘事件处理
    │  - 粘贴内容捕获 → pastedContents Record
    │  - 历史浏览 (Up/Down arrow)
    │  - Ctrl+R 搜索 → getTimestampedHistory()
    │  - 多行编辑
    │
    ├── onSubmit(text, pastedContents)
    │
    ▼
processUserInput()  (src/utils/processUserInput/)
    │
    ├── 斜杠命令检测
    │     ├── /compact → 手动压缩
    │     ├── /clear   → 清除对话
    │     ├── /model   → 切换模型
    │     ├── /help    → 显示帮助
    │     └── /share   → 分享对话
    │
    ├── 引用展开
    │     └── expandPastedTextRefs(input, pastedContents)
    │         [Pasted text #1 +10 lines] → 实际文本内容
    │
    ├── 图片内容处理
    │     └── [Image #2] → ContentBlockParam (image block)
    │
    └── createUserMessage({ content: [...] })
           │
           ▼
        Message 对象推入 mutableMessages
```

---

## 2. 上下文流 (Context Flow)

### System Context (系统上下文)

```
getSystemContext()  (src/context.ts)
    │
    ├── getGitStatus()  (memoized)
    │     │
    │     ├── getBranch()           → 当前分支名
    │     ├── getDefaultBranch()    → 默认分支 (main/master)
    │     ├── git status --short    → 文件变更状态 (截断到 2000 字符)
    │     ├── git log --oneline -5  → 最近 5 次提交
    │     └── git config user.name  → 用户名
    │
    │     所有命令通过 Promise.all() 并行执行
    │
    ├── getLocalISODate()  → 当前日期
    │
    └── systemPromptInjection  → 调试注入 (ant-only)
         │
         ▼
    { git_status: "...", date: "...", ... }
         │
         ▼
    appendSystemContext(systemPrompt, systemContext)
         └── 附加到 system prompt 末尾
```

### User Context (用户上下文)

```
getUserContext()  (src/context.ts)
    │
    ├── getClaudeMds()  (src/utils/claudemd.ts)
    │     │
    │     ├── 项目级 CLAUDE.md / .claude/CLAUDE.md
    │     ├── 全局 ~/.claude/CLAUDE.md
    │     ├── 父目录链上的 CLAUDE.md
    │     └── --add-dir 指定的额外目录中的 CLAUDE.md
    │
    ├── getMemoryFiles()
    │     └── 自动记忆文件 (MEMORY.md)
    │
    ├── filterInjectedMemoryFiles()
    │     └── 过滤重复的记忆注入
    │
    └── 合并为 { [key]: content }
         │
         ▼
    prependUserContext(messages, userContext)
         └── 注入到消息序列头部
```

### 上下文注入时序

```
fetchSystemPromptParts()  (src/utils/queryContext.ts)
    │
    ├── getSystemPrompt(tools, model)
    │     └── 基础系统提示词 (包含工具描述)
    │
    ├── getUserContext()
    │     └── CLAUDE.md + Memory files
    │
    └── getSystemContext()
          └── Git status + date
    │
    ▼
query() 内部:
    fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
    messagesForAPI   = prependUserContext(messages, userContext)
    │
    ▼
deps.callModel({
  messages: messagesForAPI,
  systemPrompt: fullSystemPrompt,
  ...
})
```

---

## 3. 工具流 (Tool Flow)

### 工具注册与组装

```
tools.ts
    │
    ├── getAllBaseTools(): Tools
    │     │  返回完整的工具列表 (~30+ 工具)
    │     │
    │     ├── AgentTool           (子 agent 创建)
    │     ├── BashTool            (shell 命令执行)
    │     ├── FileReadTool        (文件读取)
    │     ├── FileEditTool        (文件编辑)
    │     ├── FileWriteTool       (文件写入)
    │     ├── GlobTool            (文件搜索)
    │     ├── GrepTool            (内容搜索)
    │     ├── WebFetchTool        (网页获取)
    │     ├── WebSearchTool       (网络搜索)
    │     ├── TodoWriteTool       (任务列表)
    │     ├── NotebookEditTool    (Jupyter 编辑)
    │     ├── TaskStopTool        (停止任务)
    │     ├── AskUserQuestionTool (向用户提问)
    │     ├── SkillTool           (技能调用)
    │     ├── EnterPlanModeTool   (进入 plan 模式)
    │     ├── ExitPlanModeV2Tool  (退出 plan 模式)
    │     ├── BriefTool           (简洁输出)
    │     ├── TaskOutputTool      (任务输出)
    │     ├── [条件工具...]       (feature gate 控制)
    │     └── ListMcpResourcesTool, ReadMcpResourceTool
    │
    ├── getTools(permissionContext): Tools
    │     │  根据权限过滤工具
    │     │
    │     ├── filterToolsByDenyRules()  → 过滤 deny 规则
    │     ├── isEnabled() 检查         → 过滤禁用工具
    │     └── REPL mode 过滤           → 隐藏 REPL 包装的原始工具
    │
    └── assembleToolPool(permissionContext, mcpTools): Tools
          │  组装最终工具池
          │
          ├── getTools()          → 内置工具
          ├── filterMcpTools()    → MCP 工具 (deny 规则过滤)
          └── uniqBy(name)        → 去重 (内置优先)
```

### 工具执行流程

```
API 响应包含 tool_use block
    │
    ▼
tool_use block 提取
    │  { type: 'tool_use', id: 'toolu_xxx', name: 'Bash', input: { command: '...' } }
    │
    ▼
权限检查: canUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)
    │
    ├── 'allow'  → 继续执行
    ├── 'deny'   → 返回拒绝消息
    └── 'ask'    → 向用户请求权限
    │
    ▼
tool.call(input, toolUseContext)
    │
    ├── BashTool:     execFileNoThrow(command)
    ├── FileReadTool: readFile(path)
    ├── FileEditTool: applyEdit(path, oldStr, newStr)
    ├── GrepTool:     ripgrep(pattern, path)
    ├── GlobTool:     glob(pattern)
    ├── WebFetchTool: fetch(url)
    └── AgentTool:    fork query() → 子 agent 执行
    │
    ▼
tool result (ToolResultBlockParam)
    │  { type: 'tool_result', tool_use_id: 'toolu_xxx', content: '...' }
    │
    ▼
createUserMessage({ content: [toolResult] })
    │
    ▼
push to messages → 继续 query loop
```

### Streaming Tool Execution

```
StreamingToolExecutor (src/services/tools/StreamingToolExecutor.ts)
    │
    │  在 API 流式返回过程中，一旦检测到完整的 tool_use block
    │  就立即开始执行工具，不等待整个响应完成
    │
    ├── 流式检测 tool_use block 完成
    ├── 并行启动工具执行
    ├── 收集结果
    └── 与后续 tool_use block 的执行重叠
```

---

## 4. 消息流 (Message Flow)

### 消息类型体系

```typescript
// src/types/message.ts
type Message =
  | UserMessage          // 用户输入 (包含 tool_result)
  | AssistantMessage     // 助手回复 (包含 thinking, text, tool_use)
  | SystemMessage        // 系统消息 (compact boundary 等)
  | AttachmentMessage    // 附件消息 (CLAUDE.md, Memory, Skill)
```

### 消息生命周期

```
用户输入文本
    │
    ▼
createUserMessage({ content: [{ type: 'text', text: '...' }] })
    │
    ▼
message normalization (normalizeMessagesForAPI)
    │  - 移除内部字段
    │  - 确保 tool_result pairing 正确
    │  - 处理 thinking blocks 规则
    │
    ▼
prependUserContext(messages, userContext)
    │  - CLAUDE.md 作为首条 user message 注入
    │
    ▼
API 流式调用 → 接收 StreamEvent
    │
    ├── { type: 'thinking', thinking: '...' }
    ├── { type: 'text', text: '...' }
    └── { type: 'tool_use', id: '...', name: '...', input: {...} }
    │
    ▼
组装 AssistantMessage
    │  { type: 'assistant', message: { content: [...blocks] }, uuid: '...' }
    │
    ├── 如果有 tool_use blocks:
    │     │
    │     ▼
    │   tool execution → createUserMessage({ content: [{ type: 'tool_result', ... }] })
    │     │
    │     ▼
    │   messages = [...messages, assistantMsg, ...toolResultMsgs]
    │     │
    │     ▼
    │   继续 query loop (下一次 API 调用)
    │
    └── 如果没有 tool_use:
          │
          ▼
        messages = [...messages, assistantMsg]
          │
          ▼
        终止 query loop → 返回给 UI 渲染
```

### Tombstone 机制

当 fallback 到备用模型时，需要清理已生成但无效的消息：

```typescript
// 发送 tombstone 标记孤儿消息
for (const msg of assistantMessages) {
  yield { type: 'tombstone' as const, message: msg }
}
// UI 层收到 tombstone 后从显示中移除对应消息
```

---

## 5. MCP 流 (MCP Flow)

### MCP 配置加载

```
MCP 配置来源:
    │
    ├── CLI flag: --mcp-config <path>
    ├── 项目配置: .claude/mcp.json
    ├── 全局配置: ~/.claude/mcp.json
    ├── 企业管理: Enterprise MCP config
    └── Claude AI: Claude AI MCP configs (fetchClaudeAIMcpConfigsIfEligible)
    │
    ▼
parseMcpConfig() / parseMcpConfigFromFilePath()
    │
    ├── 环境变量展开 (envExpansion.ts)
    ├── 策略过滤 (filterMcpServersByPolicy)
    ├── 去重 (dedupClaudeAiMcpServers)
    └── 签名计算 (getMcpServerSignature)
    │
    ▼
ScopedMcpServerConfig[]
```

### MCP 服务器连接

```
MCP 配置
    │
    ▼
MCPConnectionManager.tsx (React 组件)
    │
    ├── 为每个 server config 创建连接
    │     ├── stdio transport (子进程)
    │     ├── SSE transport (HTTP)
    │     └── streamable-http transport
    │
    ├── 连接状态管理
    │     ├── 'pending'    → 连接中
    │     ├── 'connected'  → 已连接
    │     └── 'error'      → 连接失败
    │
    └── useManageMCPConnections() hook
```

### MCP 工具发现与集成

```
MCPServerConnection (已连接)
    │
    ▼
getMcpToolsCommandsAndResources()
    │
    ├── tools     → MCP 工具列表
    ├── commands  → MCP 命令列表
    └── resources → MCP 资源列表
    │
    ▼
AppState.mcp = { tools, commands, resources, clients }
    │
    ▼
assembleToolPool(permissionContext, mcpTools)
    │  MCP 工具与内置工具合并
    │  内置工具优先 (同名去重)
    │
    ▼
query() 中使用合并后的工具池
    │
    ├── MCP 工具执行: tool.call() → MCP server RPC
    ├── MCP 资源访问: ListMcpResourcesTool / ReadMcpResourceTool
    └── Elicitation 处理: handleElicitation (MCP -32042 errors)
```

### MCP 资源预取

```
prefetchAllMcpResources()
    │  后台预取所有 MCP 服务器的资源列表
    │
    ├── 并行请求每个 server 的资源
    ├── 缓存结果到 AppState.mcp.resources
    └── UI 可直接访问缓存
```

---

## 6. 费用流 (Cost Flow)

```
API 响应 (包含 usage 信息)
    │
    │  usage: {
    │    input_tokens: 1234,
    │    output_tokens: 567,
    │    cache_read_input_tokens: 890,
    │    cache_creation_input_tokens: 100,
    │  }
    │
    ▼
addToTotalSessionCost(usage, model)
    │
    ├── calculateUSDCost(usage, model)
    │     └── 基于模型定价计算 USD 费用
    │
    ├── addToTotalCostState(cost)
    │     └── bootstrap/state.ts: totalCostUSD += cost
    │
    ├── updateModelUsage(model, newUsage)
    │     └── bootstrap/state.ts: modelUsage[model] = accumulated
    │
    ├── getCostCounter()?.add(cost)
    │     └── OTel counter: 费用遥测
    │
    └── getTokenCounter()?.add(tokens)
          └── OTel counter: token 遥测
    │
    ▼
saveCurrentSessionCosts()  (周期性 / 退出时)
    │
    ├── getCurrentProjectConfig()
    │     └── 读取当前项目配置
    │
    ├── 写入字段:
    │     ├── lastCost: getTotalCostUSD()
    │     ├── lastAPIDuration: getTotalAPIDuration()
    │     ├── lastModelUsage: { model → { inputTokens, outputTokens, ... } }
    │     ├── lastSessionId: getSessionId()
    │     └── lastFpsAverage / lastFpsLow1Pct
    │
    └── saveCurrentProjectConfig(updater)
          └── 写入 .claude/settings.local.json
    │
    ▼
恢复 (下次 --resume):
    restoreCostStateForSession(sessionId)
    │
    ├── getStoredSessionCosts(sessionId)
    │     └── 检查 lastSessionId 匹配
    │
    └── setCostStateForRestore(data)
          └── 恢复到 bootstrap/state.ts
```

---

## 7. 渲染流 (Rendering Flow)

```
query() yield 事件
    │
    ▼
REPL.tsx (src/screens/REPL.tsx)
    │
    ├── 接收 StreamEvent
    │     ├── stream_request_start → 显示 loading
    │     ├── assistant message    → 渲染文本/思考
    │     ├── tool_use             → 显示工具调用
    │     ├── tool_result          → 显示工具结果
    │     ├── tombstone            → 移除消息
    │     └── compact boundary     → 显示压缩通知
    │
    ├── AppState 更新
    │     ├── messages: [...messages, newMsg]
    │     ├── isMessageLoading: true/false
    │     └── statusLineText: "..."
    │
    ▼
React Reconciliation (Ink)
    │
    ├── 组件树 diff
    ├── 终端输出计算
    └── 写入 stdout
    │
    ▼
Terminal Output
```

---

## 8. 会话持久化流 (Session Persistence Flow)

```
每次 query 完成后
    │
    ├── addToHistory(display, pastedContents)
    │     └── pendingEntries.push(logEntry)
    │         └── flush → ~/.claude/history.jsonl
    │
    ├── recordTranscript(messages)
    │     └── 写入 .claude/sessions/<sessionId>/transcript.jsonl
    │
    ├── saveCurrentSessionCosts()
    │     └── 写入 .claude/settings.local.json
    │
    └── flushSessionStorage()
          └── 写入 .claude/sessions/<sessionId>/session.json
```

### 会话恢复

```
claude --resume <sessionId>
    │
    ├── loadConversationForResume(sessionId)
    │     └── 读取 .claude/sessions/<sessionId>/
    │
    ├── processResumedConversation(conversation)
    │     ├── 恢复 messages
    │     ├── 恢复 file state cache
    │     └── 重建 toolUseContext
    │
    ├── restoreCostStateForSession(sessionId)
    │     └── 恢复费用累计
    │
    └── 创建 QueryEngine(config with initialMessages)
```

---

## 模块依赖关系总结

```
                    cli.tsx
                      │
                      ▼
            ┌─────── main.tsx ──────┐
            │         │              │
            ▼         ▼              ▼
         init.ts   setup.ts    launchRepl()
            │                       │
            ▼                       ▼
     配置/安全/遥测          App → REPL → PromptInput
                                    │
                                    ▼
                            QueryEngine.submitMessage()
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              context.ts      query.ts         tools.ts
              (Git/CLAUDE.md)  (主循环)        (工具注册)
                    │               │               │
                    ▼               ▼               ▼
              bootstrap/      services/api/    tools/*
              state.ts        claude.ts        (BashTool, ...)
                                    │
                                    ▼
                              Anthropic API
                                    │
                              ┌─────┼─────┐
                              ▼     ▼     ▼
                          services/ services/ services/
                          compact/  mcp/     analytics/
```
