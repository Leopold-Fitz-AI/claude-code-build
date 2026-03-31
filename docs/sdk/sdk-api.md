# Claude Code SDK 公共 API 文档

## 概述

Claude Code SDK 提供了一套完整的编程接口，允许开发者以编程方式与 Claude Code CLI 进行交互。SDK 的设计遵循分层架构原则：核心可序列化类型（core types）、运行时类型（runtime types）和控制协议类型（control types）相互分离，确保清晰的关注点分离。

**入口文件**: `src/entrypoints/agentSdkTypes.ts`

该文件从以下模块重新导出公共 API：
- `sdk/coreTypes.ts` — 通用可序列化类型（消息、配置）
- `sdk/runtimeTypes.ts` — 非可序列化类型（回调、接口方法）
- `sdk/settingsTypes.generated.ts` — 从 JSON Schema 生成的设置类型
- `sdk/toolTypes.ts` — 工具类型定义（标记为 `@internal`，待 API 稳定后公开）

---

## 公共函数

### query()

V1 API 主入口函数，用于发送单次 prompt 并获取流式响应。

```typescript
// 公共签名
function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query

// 内部签名（@internal）
function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
```

**参数说明**:
- `prompt` — 用户消息字符串，或 `SDKUserMessage` 的异步可迭代对象（用于多轮流式输入）
- `options` — 查询配置选项，包含 model、permission mode、MCP servers 等

**返回值**: `Query` 对象，为异步可迭代对象，产出 `SDKMessage` 流

**使用示例**:
```typescript
import { query } from '@anthropic-ai/claude-code'

const conversation = query({
  prompt: "请解释这段代码的功能",
  options: {
    model: 'claude-sonnet-4-6',
    maxTurns: 10,
    allowedTools: ['Read', 'Glob', 'Grep'],
  }
})

for await (const message of conversation) {
  if (message.type === 'assistant') {
    console.log(message.message)
  }
}
```

---

### unstable_v2_createSession()

V2 API（不稳定）。创建一个持久化 session，支持多轮对话。

```typescript
/** @alpha */
function unstable_v2_createSession(
  options: SDKSessionOptions
): SDKSession
```

**参数说明**:
- `options: SDKSessionOptions` — session 配置，包含 model、工作目录、权限模式等

**返回值**: `SDKSession` 对象，提供 `send()`、`abort()` 等方法

**使用示例**:
```typescript
import { unstable_v2_createSession } from '@anthropic-ai/claude-code'

const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-6',
  cwd: '/path/to/project',
  permissionMode: 'default',
})

// 发送消息并获取流式响应
const result = await session.send("列出当前目录下的文件")
```

---

### unstable_v2_resumeSession()

V2 API（不稳定）。通过 session ID 恢复已有的 session。

```typescript
/** @alpha */
function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions
): SDKSession
```

**参数说明**:
- `sessionId` — 待恢复 session 的 UUID
- `options` — session 配置选项

**使用示例**:
```typescript
import { unstable_v2_resumeSession } from '@anthropic-ai/claude-code'

const session = unstable_v2_resumeSession(
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  { model: 'claude-sonnet-4-6' }
)
```

---

### unstable_v2_prompt()

V2 API（不稳定）。一次性便捷函数，适用于单次 prompt 场景。

```typescript
/** @alpha */
async function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions
): Promise<SDKResultMessage>
```

**参数说明**:
- `message` — 用户消息文本
- `options` — session 配置选项

**返回值**: `SDKResultMessage`，包含 assistant 的最终回复和 token 用量信息

**使用示例**:
```typescript
import { unstable_v2_prompt } from '@anthropic-ai/claude-code'

const result = await unstable_v2_prompt("这里有哪些文件？", {
  model: 'claude-sonnet-4-6'
})
console.log(result)
```

---

### getSessionMessages()

从 session 的 JSONL transcript 文件中读取对话消息。解析 transcript、通过 `parentUuid` 链构建对话链路，并按时间顺序返回 user/assistant 消息。

```typescript
async function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions
): Promise<SessionMessage[]>
```

**参数说明**:
- `sessionId` — session 的 UUID
- `options` — 可选参数：
  - `dir?: string` — 项目目录路径
  - `limit?: number` — 返回消息数量限制
  - `offset?: number` — 偏移量
  - `includeSystemMessages?: boolean` — 是否包含系统消息（默认 `false`）

**返回值**: `SessionMessage[]` 数组，若 session 未找到则返回空数组

**使用示例**:
```typescript
import { getSessionMessages } from '@anthropic-ai/claude-code'

// 读取最近 20 条消息
const messages = await getSessionMessages('session-uuid', {
  limit: 20,
  includeSystemMessages: false,
})

for (const msg of messages) {
  console.log(`[${msg.role}]: ${msg.content}`)
}
```

---

### listSessions()

列出所有 session 及其元数据，支持分页。

```typescript
async function listSessions(
  options?: ListSessionsOptions
): Promise<SDKSessionInfo[]>
```

**参数说明**:
- `options` — 可选参数：
  - `dir?: string` — 项目目录（若提供则返回该目录及其 git worktree 的 session；若省略则返回所有项目的 session）
  - `limit?: number` — 分页大小
  - `offset?: number` — 分页偏移量

**使用示例**:
```typescript
import { listSessions } from '@anthropic-ai/claude-code'

// 列出特定项目的 session
const sessions = await listSessions({ dir: '/path/to/project' })

// 分页查询
const page1 = await listSessions({ limit: 50 })
const page2 = await listSessions({ limit: 50, offset: 50 })

for (const session of sessions) {
  console.log(`${session.id}: ${session.title}`)
}
```

---

### getSessionInfo()

通过 ID 读取单个 session 的元数据。与 `listSessions` 不同，该函数只读取单个 session 文件而非遍历项目中的所有 session。

```typescript
async function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions
): Promise<SDKSessionInfo | undefined>
```

**参数说明**:
- `sessionId` — session 的 UUID
- `options` — `{ dir?: string }` 项目路径；省略则搜索所有项目目录

**返回值**: `SDKSessionInfo` 或 `undefined`（若 session 文件不存在、是 sidechain session 或无法提取摘要）

---

### renameSession()

重命名 session。向 session 的 JSONL 文件追加 custom-title 条目。

```typescript
async function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions
): Promise<void>
```

**参数说明**:
- `sessionId` — session 的 UUID
- `title` — 新标题
- `options` — `{ dir?: string }` 项目路径；省略则搜索所有项目

---

### tagSession()

为 session 设置标签。传入 `null` 可清除标签。

```typescript
async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions
): Promise<void>
```

**参数说明**:
- `sessionId` — session 的 UUID
- `tag` — 标签字符串，或 `null` 清除标签
- `options` — `{ dir?: string }` 项目路径；省略则搜索所有项目

---

### forkSession()

将 session 分叉为一个新分支，分配全新的 UUID。复制源 session 的 transcript 消息到新 session 文件中，重新映射每个消息的 UUID 并保留 `parentUuid` 链。支持通过 `upToMessageId` 从对话中的特定点分叉。

分叉后的 session 没有 undo 历史（文件历史快照不会被复制）。

```typescript
async function forkSession(
  sessionId: string,
  options?: ForkSessionOptions
): Promise<ForkSessionResult>
```

**参数说明**:
- `sessionId` — 源 session 的 UUID
- `options` — 可选参数：
  - `dir?: string` — 项目目录
  - `upToMessageId?: string` — 从该消息 ID 处分叉
  - `title?: string` — 新 session 的标题

**返回值**: `ForkSessionResult` — `{ sessionId: string }` 新分叉 session 的 UUID

**使用示例**:
```typescript
import { forkSession } from '@anthropic-ai/claude-code'

const result = await forkSession('source-session-uuid', {
  upToMessageId: 'specific-message-uuid',
  title: '从此处探索替代方案',
})
console.log(`新 session: ${result.sessionId}`)
```

---

## 工具定义函数

### tool()

定义自定义 MCP 工具，可在 SDK 进程内运行。

```typescript
function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (
    args: InferShape<Schema>,
    extra: unknown
  ) => Promise<CallToolResult>,
  extras?: {
    annotations?: ToolAnnotations    // MCP 工具注解
    searchHint?: string              // 工具搜索提示
    alwaysLoad?: boolean             // 是否始终加载
  }
): SdkMcpToolDefinition<Schema>
```

**使用示例**:
```typescript
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-code'
import { z } from 'zod'

const myTool = tool(
  'get_weather',
  '获取指定城市的天气信息',
  {
    city: z.string().describe('城市名称'),
    unit: z.enum(['celsius', 'fahrenheit']).optional(),
  },
  async (args) => {
    const weather = await fetchWeather(args.city, args.unit)
    return {
      content: [{ type: 'text', text: JSON.stringify(weather) }],
    }
  },
  {
    annotations: { readOnly: true, openWorld: true },
    searchHint: 'weather forecast temperature',
  }
)
```

---

### createSdkMcpServer()

创建一个 MCP server 实例，用于 SDK transport。允许 SDK 用户定义在同一进程内运行的自定义工具。

> 如果 SDK MCP 调用运行时间超过 60 秒，请覆盖 `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` 环境变量。

```typescript
type CreateSdkMcpServerOptions = {
  name: string                              // server 名称
  version?: string                          // server 版本号
  tools?: Array<SdkMcpToolDefinition<any>>  // 工具定义数组
}

function createSdkMcpServer(
  options: CreateSdkMcpServerOptions
): McpSdkServerConfigWithInstance
```

**使用示例**:
```typescript
import { tool, createSdkMcpServer, query } from '@anthropic-ai/claude-code'
import { z } from 'zod'

const weatherTool = tool(
  'get_weather',
  '获取天气',
  { city: z.string() },
  async (args) => ({
    content: [{ type: 'text', text: `${args.city}: 晴, 25°C` }],
  })
)

const mcpServer = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [weatherTool],
})

// 在 query 中使用
const conversation = query({
  prompt: "北京今天天气怎么样？",
  options: {
    mcpServers: { 'my-tools': mcpServer },
  }
})
```

---

## AbortError 类

用于取消操作的错误类。当通过 `AbortController` 取消正在进行的操作时抛出。

```typescript
class AbortError extends Error {}
```

**使用示例**:
```typescript
import { query, AbortError } from '@anthropic-ai/claude-code'

const controller = new AbortController()

try {
  const conversation = query({
    prompt: "分析这个大型代码库",
    options: { signal: controller.signal }
  })

  // 5 秒后取消
  setTimeout(() => controller.abort(), 5000)

  for await (const msg of conversation) {
    console.log(msg)
  }
} catch (err) {
  if (err instanceof AbortError) {
    console.log('操作已取消')
  }
}
```

---

## 核心导出类型

### 消息类型（Messages）

从 `sdk/coreTypes.ts` 导出：

| 类型名 | 描述 |
|--------|------|
| `SDKMessage` | SDK 输出的通用消息类型 |
| `SDKUserMessage` | 用户输入消息 |
| `SDKResultMessage` | 最终结果消息，包含 token 用量 |
| `SDKSessionInfo` | session 元数据信息 |
| `SessionMessage` | 从 transcript 读取的消息 |

### 配置类型（Configs）

| 类型名 | 描述 |
|--------|------|
| `Options` | V1 query() 的公共配置选项 |
| `InternalOptions` | V1 query() 的内部配置选项（@internal） |
| `SDKSessionOptions` | V2 session 配置选项 |
| `Settings` | 用户/项目/本地设置（从 JSON Schema 生成） |

### Hook 类型

| 类型名 | 描述 |
|--------|------|
| `HookEvent` | 26 种 hook 事件类型枚举 |
| `HookInput` | hook 回调输入联合类型 |

### 工具类型（Tools）

| 类型名 | 描述 |
|--------|------|
| `SdkMcpToolDefinition` | SDK MCP 工具定义 |
| `McpSdkServerConfigWithInstance` | SDK MCP server 配置及实例 |
| `CallToolResult` | MCP 工具调用结果（来自 `@modelcontextprotocol/sdk`） |
| `ToolAnnotations` | MCP 工具注解（readOnly, destructive, openWorld） |

### Session 管理类型

| 类型名 | 描述 |
|--------|------|
| `ListSessionsOptions` | `listSessions()` 的选项类型 |
| `GetSessionInfoOptions` | `getSessionInfo()` 的选项类型 |
| `GetSessionMessagesOptions` | `getSessionMessages()` 的选项类型 |
| `SessionMutationOptions` | `renameSession()` / `tagSession()` 的选项类型 |
| `ForkSessionOptions` | `forkSession()` 的选项类型 |
| `ForkSessionResult` | `forkSession()` 的返回类型 |
| `SDKSession` | V2 session 实例类型 |

---

## Sandbox 类型

SDK 支持沙箱配置，用于限制 Claude Code 的文件系统和网络访问。

### 网络配置（Network Config）

```typescript
type NetworkConfig = {
  allowedDomains?: string[]   // 允许访问的域名列表
  proxy?: {
    url: string               // 代理服务器 URL
    allowList?: string[]      // 代理白名单
  }
}
```

### 文件系统配置（Filesystem Config）

```typescript
type FilesystemConfig = {
  allowWrite?: string[]       // 允许写入的路径 glob 模式
  allowRead?: string[]        // 允许读取的路径 glob 模式
  deny?: string[]             // 拒绝访问的路径 glob 模式
}
```

---

## 内部 API（@internal）

以下 API 标记为 `@internal`，仅供 Anthropic 内部使用，不属于公共 API 契约：

### 定时任务相关

| 函数/类型 | 描述 |
|-----------|------|
| `CronTask` | 来自 `.claude/scheduled_tasks.json` 的定时任务 |
| `CronJitterConfig` | cron 调度器调优参数（抖动 + 过期） |
| `ScheduledTaskEvent` | `watchScheduledTasks()` 产出的事件 |
| `ScheduledTasksHandle` | `watchScheduledTasks()` 的返回句柄 |
| `watchScheduledTasks()` | 监听定时任务文件并在任务触发时产出事件 |
| `buildMissedTaskNotification()` | 格式化错过的一次性任务为 prompt |

### 远程控制相关

| 函数/类型 | 描述 |
|-----------|------|
| `InboundPrompt` | 从 claude.ai bridge WebSocket 提取的用户消息 |
| `ConnectRemoteControlOptions` | `connectRemoteControl()` 的选项 |
| `RemoteControlHandle` | 远程控制连接句柄 |
| `connectRemoteControl()` | 从 daemon 进程维持 claude.ai 远程控制桥接 |

---

## 模块导入路径

```typescript
// 公共 SDK API（推荐）
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-code'

// 控制协议类型（SDK 构建者使用）
import type { SDKControlRequest, SDKControlResponse } from '@anthropic-ai/claude-code'

// 设置类型
import type { Settings } from '@anthropic-ai/claude-code'
```

> **注意**: 控制协议类型（`SDKControlRequest`、`SDKControlResponse`）标记为 `@alpha`，仅供 SDK 实现者（如 Python SDK）使用，不建议直接使用。
