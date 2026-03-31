# Claude Code SDK 控制协议文档

## 概述

控制协议（Control Protocol）是 SDK 实现与 CLI 进程之间的双向通信机制。SDK（如 Python SDK）通过 stdin/stdout 管道与 CLI 子进程交换 JSON 消息，实现会话初始化、权限管理、模型切换、MCP 服务器管理等控制操作。

所有 schema 使用 Zod（v4）定义，是 SDK 数据类型的唯一真实来源（single source of truth）。TypeScript 类型从这些 schema 自动生成。

**源文件**:
- `src/entrypoints/sdk/controlSchemas.ts` — 控制协议 Zod schema
- `src/entrypoints/sdk/coreSchemas.ts` — 核心数据类型 Zod schema

---

## 控制请求类型（Control Request Types）

所有控制请求封装在 `SDKControlRequestSchema` 中：

```typescript
// 请求包装器
const SDKControlRequestSchema = z.object({
  type: z.literal('control_request'),
  request_id: z.string(),                  // 唯一请求 ID，用于匹配响应
  request: SDKControlRequestInnerSchema(), // 具体请求体（discriminated union）
})
```

`SDKControlRequestInnerSchema` 是以下所有请求类型的联合类型。

---

### SDKControlInitializeRequest

初始化 SDK session，配置 hooks、MCP servers 和 agent。这是 session 建立后**必须发送的第一个请求**。

```typescript
const SDKControlInitializeRequestSchema = z.object({
  subtype: z.literal('initialize'),

  // Hook 回调映射：事件类型 → 回调匹配器数组
  hooks: z.record(
    HookEventSchema(),                      // 26 种事件类型
    z.array(SDKHookCallbackMatcherSchema()) // 匹配器配置
  ).optional(),

  // SDK MCP server 名称列表
  sdkMcpServers: z.array(z.string()).optional(),

  // JSON Schema 输出格式约束
  jsonSchema: z.record(z.string(), z.unknown()).optional(),

  // 自定义系统 prompt
  systemPrompt: z.string().optional(),

  // 附加到默认系统 prompt 之后
  appendSystemPrompt: z.string().optional(),

  // Agent 定义映射
  agents: z.record(z.string(), AgentDefinitionSchema()).optional(),

  // 是否启用 prompt 建议
  promptSuggestions: z.boolean().optional(),

  // 是否启用 agent 进度摘要
  agentProgressSummaries: z.boolean().optional(),
})
```

**初始化响应**:

```typescript
const SDKControlInitializeResponseSchema = z.object({
  commands: z.array(SlashCommandSchema()),         // 可用斜杠命令列表
  agents: z.array(AgentInfoSchema()),              // 可用 agent 列表
  output_style: z.string(),                        // 当前输出样式
  available_output_styles: z.array(z.string()),    // 可用输出样式列表
  models: z.array(ModelInfoSchema()),              // 可用模型列表
  account: AccountInfoSchema(),                    // 账户信息
  pid: z.number().optional(),                      // @internal CLI 进程 PID
  fast_mode_state: FastModeStateSchema().optional(), // 快速模式状态
})
```

**Hook 回调匹配器**:

```typescript
const SDKHookCallbackMatcherSchema = z.object({
  matcher: z.string().optional(),       // 正则匹配模式（如匹配工具名）
  hookCallbackIds: z.array(z.string()), // 回调 ID 列表
  timeout: z.number().optional(),       // 超时时间（毫秒）
})
```

**使用示例**:

```json
{
  "type": "control_request",
  "request_id": "init-001",
  "request": {
    "subtype": "initialize",
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash|Write",
          "hookCallbackIds": ["hook-pre-tool-1"],
          "timeout": 5000
        }
      ],
      "Stop": [
        {
          "hookCallbackIds": ["hook-stop-1"]
        }
      ]
    },
    "sdkMcpServers": ["my-custom-tools"],
    "systemPrompt": "你是一个专业的代码审查助手。"
  }
}
```

---

### SDKControlSetPermissionModeRequest

运行时动态切换权限模式。

```typescript
const SDKControlSetPermissionModeRequestSchema = z.object({
  subtype: z.literal('set_permission_mode'),
  mode: PermissionModeSchema(),
  ultraplan: z.boolean().optional(),  // @internal CCR ultraplan session 标记
})
```

**PermissionMode 枚举值**:

| 模式 | 描述 |
|------|------|
| `'default'` | 标准行为，危险操作时提示用户确认 |
| `'acceptEdits'` | 自动接受文件编辑操作 |
| `'bypassPermissions'` | 跳过所有权限检查（需要 `allowDangerouslySkipPermissions`） |
| `'plan'` | 规划模式，不执行实际工具操作 |
| `'dontAsk'` | 不提示权限，未预批准则拒绝 |

**使用示例**:

```json
{
  "type": "control_request",
  "request_id": "perm-001",
  "request": {
    "subtype": "set_permission_mode",
    "mode": "acceptEdits"
  }
}
```

---

### SDKControlSetModelRequest

运行时切换模型。

```typescript
const SDKControlSetModelRequestSchema = z.object({
  subtype: z.literal('set_model'),
  model: z.string().optional(),  // 模型标识符，如 'claude-sonnet-4-6'
})
```

---

### SDKControlSetMaxThinkingTokensRequest

设置 extended thinking 的最大 token 数。

```typescript
const SDKControlSetMaxThinkingTokensRequestSchema = z.object({
  subtype: z.literal('set_max_thinking_tokens'),
  max_thinking_tokens: z.number().nullable(),  // null 表示使用默认值
})
```

---

### SDKControlPermissionRequest

CLI 向 SDK 发送的工具执行权限请求。当 CLI 需要执行工具但需要用户确认时发出。

```typescript
const SDKControlPermissionRequestSchema = z.object({
  subtype: z.literal('can_use_tool'),
  tool_name: z.string(),                                     // 工具名称
  input: z.record(z.string(), z.unknown()),                  // 工具输入参数
  permission_suggestions: z.array(PermissionUpdateSchema()).optional(), // 建议的权限更新
  blocked_path: z.string().optional(),                       // 被阻止的文件路径
  decision_reason: z.string().optional(),                    // 决策原因
  title: z.string().optional(),                              // 显示标题
  display_name: z.string().optional(),                       // 显示名称
  tool_use_id: z.string(),                                   // 工具使用 ID
  agent_id: z.string().optional(),                           // subagent ID
  description: z.string().optional(),                        // 操作描述
})
```

**权限响应示例**（SDK 回复允许）:

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "perm-req-001",
    "response": {
      "behavior": "allow",
      "updatedPermissions": [
        {
          "type": "addRules",
          "rules": [{ "toolName": "Bash", "ruleContent": "npm test" }],
          "behavior": "allow",
          "destination": "session"
        }
      ]
    }
  }
}
```

---

### SDKControlMcpStatusRequest

查询所有 MCP server 连接的当前状态。

```typescript
const SDKControlMcpStatusRequestSchema = z.object({
  subtype: z.literal('mcp_status'),
})
```

**MCP 状态响应**:

```typescript
const SDKControlMcpStatusResponseSchema = z.object({
  mcpServers: z.array(McpServerStatusSchema()),
})

// McpServerStatusSchema 包含：
// name: string            — server 名称
// status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
// serverInfo?: { name, version }  — server 信息
// error?: string          — 错误消息
// config?: McpServerStatusConfigSchema  — server 配置
// scope?: string          — 配置范围
// tools?: Array<{ name, description?, annotations? }>  — 提供的工具列表
// capabilities?: { experimental?: Record<string, unknown> }  — 能力声明
```

---

### SDKControlGetContextUsageRequest

获取当前 context window 使用量的详细分类。

```typescript
const SDKControlGetContextUsageRequestSchema = z.object({
  subtype: z.literal('get_context_usage'),
})
```

**上下文使用量响应**:

```typescript
const SDKControlGetContextUsageResponseSchema = z.object({
  categories: z.array(ContextCategorySchema()),  // 使用量分类
  totalTokens: z.number(),                       // 总 token 数
  maxTokens: z.number(),                         // 最大 token 限制
  rawMaxTokens: z.number(),                      // 原始最大 token 限制
  percentage: z.number(),                        // 使用百分比
  gridRows: z.array(z.array(ContextGridSquareSchema())), // 可视化网格
  model: z.string(),                             // 当前模型
  memoryFiles: z.array(z.object({                // 记忆文件
    path: z.string(),
    type: z.string(),
    tokens: z.number(),
  })),
  mcpTools: z.array(z.object({                   // MCP 工具
    name: z.string(),
    serverName: z.string(),
    tokens: z.number(),
    isLoaded: z.boolean().optional(),
  })),
  deferredBuiltinTools: z.array(z.object({       // 延迟加载的内置工具
    name: z.string(),
    tokens: z.number(),
    isLoaded: z.boolean(),
  })).optional(),
  systemTools: z.array(z.object({                // 系统工具
    name: z.string(),
    tokens: z.number(),
  })).optional(),
  systemPromptSections: z.array(z.object({       // 系统 prompt 分段
    name: z.string(),
    tokens: z.number(),
  })).optional(),
  agents: z.array(z.object({                     // agent 信息
    agentType: z.string(),
    source: z.string(),
    tokens: z.number(),
  })),
  slashCommands: z.object({                      // 斜杠命令统计
    totalCommands: z.number(),
    includedCommands: z.number(),
    tokens: z.number(),
  }).optional(),
  skills: z.object({                             // 技能统计
    totalSkills: z.number(),
    includedSkills: z.number(),
    tokens: z.number(),
    skillFrontmatter: z.array(z.object({
      name: z.string(),
      source: z.string(),
      tokens: z.number(),
    })),
  }).optional(),
  autoCompactThreshold: z.number().optional(),   // 自动压缩阈值
  isAutoCompactEnabled: z.boolean(),             // 是否启用自动压缩
  messageBreakdown: z.object({                   // 消息细分
    toolCallTokens: z.number(),
    toolResultTokens: z.number(),
    attachmentTokens: z.number(),
    assistantMessageTokens: z.number(),
    userMessageTokens: z.number(),
    toolCallsByType: z.array(z.object({
      name: z.string(),
      callTokens: z.number(),
      resultTokens: z.number(),
    })),
    attachmentsByType: z.array(z.object({
      name: z.string(),
      tokens: z.number(),
    })),
  }).optional(),
  apiUsage: z.object({                           // API 使用量
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    cache_read_input_tokens: z.number(),
  }).nullable(),
})
```

---

### SDKControlRewindFilesRequest

撤销自特定用户消息以来的文件更改。

```typescript
const SDKControlRewindFilesRequestSchema = z.object({
  subtype: z.literal('rewind_files'),
  user_message_id: z.string(),     // 回滚到该消息之前的状态
  dry_run: z.boolean().optional(), // 仅预览，不实际执行
})
```

**回滚响应**:

```typescript
const SDKControlRewindFilesResponseSchema = z.object({
  canRewind: z.boolean(),           // 是否可以回滚
  error: z.string().optional(),     // 错误信息
  filesChanged: z.array(z.string()).optional(), // 受影响的文件列表
  insertions: z.number().optional(), // 新增行数
  deletions: z.number().optional(),  // 删除行数
})
```

---

### SDKControlMcpSetServersRequest

替换动态管理的 MCP server 集合。

```typescript
const SDKControlMcpSetServersRequestSchema = z.object({
  subtype: z.literal('mcp_set_servers'),
  servers: z.record(z.string(), McpServerConfigForProcessTransportSchema()),
})
```

**替换响应**:

```typescript
const SDKControlMcpSetServersResponseSchema = z.object({
  added: z.array(z.string()),              // 新增的 server
  removed: z.array(z.string()),            // 移除的 server
  errors: z.record(z.string(), z.string()), // 连接失败的 server 及错误信息
})
```

**使用示例**:

```json
{
  "type": "control_request",
  "request_id": "mcp-set-001",
  "request": {
    "subtype": "mcp_set_servers",
    "servers": {
      "my-db-server": {
        "type": "stdio",
        "command": "node",
        "args": ["./mcp-db-server.js"],
        "env": { "DB_URL": "postgres://localhost/mydb" }
      },
      "remote-api": {
        "type": "http",
        "url": "https://api.example.com/mcp",
        "headers": { "Authorization": "Bearer token123" }
      }
    }
  }
}
```

---

### 其他控制请求

| 请求 subtype | Schema | 描述 |
|-------------|--------|------|
| `'interrupt'` | `SDKControlInterruptRequestSchema` | 中断当前正在运行的对话轮次 |
| `'seed_read_state'` | `SDKControlSeedReadStateRequestSchema` | 为 readFileState 缓存注入 path+mtime 条目，解决因 snip 导致的 Edit 校验失败 |
| `'hook_callback'` | `SDKHookCallbackRequestSchema` | 传递 hook 回调及其输入数据 |
| `'mcp_message'` | `SDKControlMcpMessageRequestSchema` | 向特定 MCP server 发送 JSON-RPC 消息 |
| `'mcp_reconnect'` | `SDKControlMcpReconnectRequestSchema` | 重新连接断开或失败的 MCP server |
| `'mcp_toggle'` | `SDKControlMcpToggleRequestSchema` | 启用或禁用 MCP server |
| `'stop_task'` | `SDKControlStopTaskRequestSchema` | 停止正在运行的任务 |
| `'apply_flag_settings'` | `SDKControlApplyFlagSettingsRequestSchema` | 将设置合并到 flag settings 层 |
| `'get_settings'` | `SDKControlGetSettingsRequestSchema` | 返回有效合并设置及各来源原始设置 |
| `'cancel_async_message'` | `SDKControlCancelAsyncMessageRequestSchema` | 从命令队列中取消待处理的异步用户消息 |
| `'reload_plugins'` | `SDKControlReloadPluginsRequestSchema` | 从磁盘重新加载插件并返回刷新后的 session 组件 |
| `'elicitation'` | `SDKControlElicitationRequestSchema` | 请求 SDK 消费者处理 MCP elicitation（用户输入请求） |

---

## 控制响应类型（Control Response Types）

### 成功响应

```typescript
const ControlResponseSchema = z.object({
  subtype: z.literal('success'),
  request_id: z.string(),                           // 对应请求的 ID
  response: z.record(z.string(), z.unknown()).optional(), // 响应数据
})
```

### 错误响应

```typescript
const ControlErrorResponseSchema = z.object({
  subtype: z.literal('error'),
  request_id: z.string(),                                    // 对应请求的 ID
  error: z.string(),                                         // 错误描述
  pending_permission_requests: z.array(SDKControlRequestSchema()).optional(), // 待处理的权限请求
})
```

### 响应包装器

```typescript
const SDKControlResponseSchema = z.object({
  type: z.literal('control_response'),
  response: z.union([
    ControlResponseSchema(),
    ControlErrorResponseSchema(),
  ]),
})
```

### 请求取消

```typescript
const SDKControlCancelRequestSchema = z.object({
  type: z.literal('control_cancel_request'),
  request_id: z.string(),  // 要取消的请求 ID
})
```

### Keep-Alive 消息

```typescript
const SDKKeepAliveMessageSchema = z.object({
  type: z.literal('keep_alive'),
})
```

### 环境变量更新

```typescript
const SDKUpdateEnvironmentVariablesMessageSchema = z.object({
  type: z.literal('update_environment_variables'),
  variables: z.record(z.string(), z.string()),
})
```

---

## 聚合消息类型

### Stdout 消息（CLI → SDK）

```typescript
const StdoutMessageSchema = z.union([
  SDKMessageSchema(),                           // 对话消息
  SDKStreamlinedTextMessageSchema(),            // 精简文本消息
  SDKStreamlinedToolUseSummaryMessageSchema(),  // 精简工具使用摘要
  SDKPostTurnSummaryMessageSchema(),            // 轮次后摘要
  SDKControlResponseSchema(),                   // 控制响应
  SDKControlRequestSchema(),                    // 控制请求（如权限请求）
  SDKControlCancelRequestSchema(),              // 请求取消
  SDKKeepAliveMessageSchema(),                  // Keep-Alive
])
```

### Stdin 消息（SDK → CLI）

```typescript
const StdinMessageSchema = z.union([
  SDKUserMessageSchema(),                          // 用户消息
  SDKControlRequestSchema(),                       // 控制请求
  SDKControlResponseSchema(),                      // 控制响应（如权限回复）
  SDKKeepAliveMessageSchema(),                     // Keep-Alive
  SDKUpdateEnvironmentVariablesMessageSchema(),    // 环境变量更新
])
```

---

## 核心 Schema 类型（coreSchemas.ts）

### 使用量与模型类型

```typescript
const ModelUsageSchema = z.object({
  inputTokens: z.number(),              // 输入 token 数
  outputTokens: z.number(),             // 输出 token 数
  cacheReadInputTokens: z.number(),     // 缓存读取输入 token 数
  cacheCreationInputTokens: z.number(), // 缓存创建输入 token 数
  webSearchRequests: z.number(),        // Web 搜索请求数
  costUSD: z.number(),                  // 成本（美元）
  contextWindow: z.number(),            // 上下文窗口大小
  maxOutputTokens: z.number(),          // 最大输出 token 数
})
```

### 输出格式类型

```typescript
const JsonSchemaOutputFormatSchema = z.object({
  type: z.literal('json_schema'),
  schema: z.record(z.string(), z.unknown()),  // JSON Schema 定义
})
```

### 配置类型

```typescript
// API Key 来源
const ApiKeySourceSchema = z.enum([
  'user',       // 用户级别
  'project',    // 项目级别
  'org',        // 组织级别
  'temporary',  // 临时
  'oauth',      // OAuth 认证
])

// 配置作用域
const ConfigScopeSchema = z.enum([
  'local',      // 本地（.claude/settings.local.json）
  'user',       // 用户（~/.claude/settings.json）
  'project',    // 项目（.claude/settings.json）
])

// 扩展思考配置
const ThinkingConfigSchema = z.union([
  z.object({
    type: z.literal('adaptive'),           // Claude 自行决定何时及多少思考（Opus 4.6+）
  }),
  z.object({
    type: z.literal('enabled'),
    budgetTokens: z.number().optional(),   // 固定思考 token 预算（旧模型）
  }),
  z.object({
    type: z.literal('disabled'),           // 禁用扩展思考
  }),
])
```

### SDK Beta 标识

```typescript
const SdkBetaSchema = z.literal('context-1m-2025-08-07')
```

该 beta 标识启用 1M context window 支持。

---

### MCP Server 配置类型

SDK 支持四种 MCP server 传输类型：

```typescript
// Stdio 传输（本地进程）
const McpStdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(),  // 可选，向后兼容
  command: z.string(),                  // 启动命令
  args: z.array(z.string()).optional(), // 命令参数
  env: z.record(z.string(), z.string()).optional(), // 环境变量
})

// SSE 传输（Server-Sent Events）
const McpSSEServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string(),                                     // SSE 端点 URL
  headers: z.record(z.string(), z.string()).optional(), // 请求头
})

// HTTP 传输（Streamable HTTP）
const McpHttpServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string(),                                     // HTTP 端点 URL
  headers: z.record(z.string(), z.string()).optional(), // 请求头
})

// SDK 传输（进程内）
const McpSdkServerConfigSchema = z.object({
  type: z.literal('sdk'),
  name: z.string(),  // server 名称，对应 createSdkMcpServer 的 name
})

// 仅在状态响应中出现（输出专用）
const McpClaudeAIProxyServerConfigSchema = z.object({
  type: z.literal('claudeai-proxy'),
  url: z.string(),
  id: z.string(),
})
```

**完整 MCP 配置示例**:

```json
{
  "my-local-tools": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@myorg/mcp-server"],
    "env": { "API_KEY": "sk-xxx" }
  },
  "remote-api": {
    "type": "http",
    "url": "https://mcp.example.com/api",
    "headers": { "Authorization": "Bearer token" }
  },
  "legacy-sse": {
    "type": "sse",
    "url": "https://old-mcp.example.com/events"
  },
  "in-process": {
    "type": "sdk",
    "name": "my-sdk-server"
  }
}
```

---

### 权限 Schema 类型

```typescript
// 权限行为
const PermissionBehaviorSchema = z.enum(['allow', 'deny', 'ask'])

// 权限规则值
const PermissionRuleValueSchema = z.object({
  toolName: z.string(),               // 工具名称
  ruleContent: z.string().optional(), // 规则内容（如 Bash 命令模式）
})

// 权限更新（discriminated union）
const PermissionUpdateSchema = z.discriminatedUnion('type', [
  // 添加规则
  z.object({
    type: z.literal('addRules'),
    rules: z.array(PermissionRuleValueSchema()),
    behavior: PermissionBehaviorSchema(),
    destination: PermissionUpdateDestinationSchema(),
  }),
  // 替换规则
  z.object({
    type: z.literal('replaceRules'),
    rules: z.array(PermissionRuleValueSchema()),
    behavior: PermissionBehaviorSchema(),
    destination: PermissionUpdateDestinationSchema(),
  }),
  // 移除规则
  z.object({
    type: z.literal('removeRules'),
    rules: z.array(PermissionRuleValueSchema()),
    behavior: PermissionBehaviorSchema(),
    destination: PermissionUpdateDestinationSchema(),
  }),
  // 设置模式
  z.object({
    type: z.literal('setMode'),
    mode: PermissionModeSchema(),
    destination: PermissionUpdateDestinationSchema(),
  }),
  // 添加目录
  z.object({
    type: z.literal('addDirectories'),
    directories: z.array(z.string()),
    destination: PermissionUpdateDestinationSchema(),
  }),
  // 移除目录
  z.object({
    type: z.literal('removeDirectories'),
    directories: z.array(z.string()),
    destination: PermissionUpdateDestinationSchema(),
  }),
])

// 权限更新目标
const PermissionUpdateDestinationSchema = z.enum([
  'userSettings',     // 用户设置
  'projectSettings',  // 项目设置
  'localSettings',    // 本地设置
  'session',          // 仅当前 session
  'cliArg',           // CLI 参数
])

// 权限决策分类（用于遥测）
const PermissionDecisionClassificationSchema = z.enum([
  'user_temporary',   // 单次允许
  'user_permanent',   // 始终允许
  'user_reject',      // 拒绝
])

// 权限结果
const PermissionResultSchema = z.union([
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    updatedPermissions: z.array(PermissionUpdateSchema()).optional(),
    toolUseID: z.string().optional(),
    decisionClassification: PermissionDecisionClassificationSchema().optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
    decisionClassification: PermissionDecisionClassificationSchema().optional(),
  }),
])
```

---

## Hook 事件类型（26 种）

所有 hook 共享 `BaseHookInput` 基础字段：

```typescript
const BaseHookInputSchema = z.object({
  session_id: z.string(),         // session UUID
  transcript_path: z.string(),    // transcript JSONL 文件路径
  cwd: z.string(),                // 当前工作目录
  permission_mode: z.string().optional(), // 当前权限模式
  agent_id: z.string().optional(),       // subagent ID（仅在 subagent 内触发时存在）
  agent_type: z.string().optional(),     // agent 类型名称
})
```

### Hook 事件列表

| 事件名 | 输入 Schema | 特有字段 |
|--------|------------|---------|
| `PreToolUse` | `PreToolUseHookInputSchema` | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | `PostToolUseHookInputSchema` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id` |
| `PostToolUseFailure` | `PostToolUseFailureHookInputSchema` | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt?` |
| `PermissionRequest` | `PermissionRequestHookInputSchema` | `tool_name`, `tool_input`, `permission_suggestions?` |
| `PermissionDenied` | `PermissionDeniedHookInputSchema` | `tool_name`, `tool_input`, `tool_use_id`, `reason` |
| `Notification` | `NotificationHookInputSchema` | `message`, `title?`, `notification_type` |
| `UserPromptSubmit` | `UserPromptSubmitHookInputSchema` | `prompt` |
| `SessionStart` | `SessionStartHookInputSchema` | `source: 'startup'\|'resume'\|'clear'\|'compact'`, `model?` |
| `SessionEnd` | `SessionEndHookInputSchema` | `reason: 'clear'\|'resume'\|'logout'\|...` |
| `Stop` | `StopHookInputSchema` | `stop_hook_active`, `last_assistant_message?` |
| `StopFailure` | `StopFailureHookInputSchema` | `error`, `error_details?`, `last_assistant_message?` |
| `SubagentStart` | `SubagentStartHookInputSchema` | `agent_id`, `agent_type` |
| `SubagentStop` | `SubagentStopHookInputSchema` | `stop_hook_active`, `agent_id`, `agent_transcript_path`, `agent_type`, `last_assistant_message?` |
| `PreCompact` | `PreCompactHookInputSchema` | `trigger: 'manual'\|'auto'`, `custom_instructions` |
| `PostCompact` | `PostCompactHookInputSchema` | `trigger: 'manual'\|'auto'`, `compact_summary` |
| `Setup` | `SetupHookInputSchema` | `trigger: 'init'\|'maintenance'` |
| `TeammateIdle` | `TeammateIdleHookInputSchema` | `teammate_name`, `team_name` |
| `TaskCreated` | `TaskCreatedHookInputSchema` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |
| `TaskCompleted` | `TaskCompletedHookInputSchema` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |
| `Elicitation` | `ElicitationHookInputSchema` | `mcp_server_name`, `message`, `mode?`, `url?`, `elicitation_id?`, `requested_schema?` |
| `ElicitationResult` | `ElicitationResultHookInputSchema` | `mcp_server_name`, `elicitation_id?`, `mode?`, `action`, `content?` |
| `ConfigChange` | `ConfigChangeHookInputSchema` | `source`, `file_path?` |
| `InstructionsLoaded` | `InstructionsLoadedHookInputSchema` | `file_path`, `memory_type`, `load_reason`, `globs?`, `trigger_file_path?`, `parent_file_path?` |
| `WorktreeCreate` | `WorktreeCreateHookInputSchema` | `name` |
| `WorktreeRemove` | `WorktreeRemoveHookInputSchema` | `worktree_path` |
| `CwdChanged` | `CwdChangedHookInputSchema` | `old_cwd`, `new_cwd` |
| `FileChanged` | `FileChangedHookInputSchema` | `file_path`, `event: 'change'\|'add'\|'unlink'` |

### Hook 输出 Schema

同步 hook 返回 `SyncHookJSONOutputSchema`：

```typescript
const SyncHookJSONOutputSchema = z.object({
  continue: z.boolean().optional(),           // 是否继续执行
  suppressOutput: z.boolean().optional(),     // 是否抑制输出
  stopReason: z.string().optional(),          // 停止原因
  decision: z.enum(['approve', 'block']).optional(), // 批准或阻止
  systemMessage: z.string().optional(),       // 注入系统消息
  reason: z.string().optional(),              // 决策原因
  hookSpecificOutput: z.union([...]).optional(), // 事件特定输出
})
```

异步 hook 返回 `AsyncHookJSONOutputSchema`：

```typescript
const AsyncHookJSONOutputSchema = z.object({
  async: z.literal(true),
  asyncTimeout: z.number().optional(),  // 异步超时（毫秒）
})
```

---

## 设置请求和响应

### get_settings

```typescript
// 响应
const SDKControlGetSettingsResponseSchema = z.object({
  effective: z.record(z.string(), z.unknown()), // 最终合并后的有效设置

  sources: z.array(z.object({
    source: z.enum([
      'userSettings',     // 用户设置（优先级低）
      'projectSettings',  // 项目设置
      'localSettings',    // 本地设置
      'flagSettings',     // flag 设置
      'policySettings',   // 策略设置（优先级高）
    ]),
    settings: z.record(z.string(), z.unknown()),
  })),

  applied: z.object({
    model: z.string(),
    effort: z.enum(['low', 'medium', 'high', 'max']).nullable(),
  }).optional(),
})
```

`sources` 按优先级从低到高排列 -- 后面的条目覆盖前面的。`applied` 反映实际发送到 API 的运行时解析值（考虑环境变量覆盖、session 状态和模型特定默认值）。

---

## 通信流程示例

完整的 SDK ↔ CLI 通信流程：

```
SDK (stdin)                                CLI (stdout)
    │                                          │
    │─── control_request (initialize) ────────>│
    │<── control_response (success) ───────────│
    │                                          │
    │─── SDKUserMessage ──────────────────────>│
    │<── SDKMessage (assistant) ───────────────│
    │<── control_request (can_use_tool) ───────│
    │                                          │
    │─── control_response (allow) ────────────>│
    │<── SDKMessage (tool_result) ─────────────│
    │<── SDKMessage (assistant) ───────────────│
    │<── SDKMessage (result) ──────────────────│
    │                                          │
    │─── control_request (get_context_usage) ─>│
    │<── control_response (usage data) ────────│
    │                                          │
    │─── keep_alive ──────────────────────────>│
    │<── keep_alive ───────────────────────────│
```
