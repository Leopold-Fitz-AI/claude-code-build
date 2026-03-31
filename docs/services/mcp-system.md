# MCP (Model Context Protocol) 系统

> MCP 是 Claude Code 的工具发现与集成协议。基于客户端-服务器模型，支持多种传输方式和认证机制。
> 源码路径: `src/services/mcp/`

---

## 目录

- [总体架构](#总体架构)
- [传输类型](#传输类型)
- [类型定义 (types.ts)](#类型定义-typests)
- [客户端实现 (client.ts)](#客户端实现-clientts)
- [配置系统 (config.ts)](#配置系统-configts)
- [认证 (auth.ts)](#认证-authts)
- [MCP Server 入口 (entrypoints/mcp.ts)](#mcp-server-入口-entrypointsmcpts)
- [辅助模块](#辅助模块)

---

## 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code 主进程                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              MCP Client (client.ts)                      │   │
│  │  ┌──────────┐ ┌──────────────┐ ┌──────────────────────┐ │   │
│  │  │ listTools│ │ callTool     │ │ listResources        │ │   │
│  │  └──────────┘ └──────────────┘ └──────────────────────┘ │   │
│  └────────────┬─────────────────────────────────────────────┘   │
│               │                                                 │
│  ┌────────────┴─────────────────────────────────────────────┐   │
│  │              Transport Layer                              │   │
│  │  ┌───────┐ ┌─────┐ ┌──────┐ ┌─────┐ ┌───────┐ ┌─────┐  │   │
│  │  │ Stdio │ │ SSE │ │ HTTP │ │ WS  │ │SDK Ctl│ │Proxy│  │   │
│  │  └───┬───┘ └──┬──┘ └──┬───┘ └──┬──┘ └───┬───┘ └──┬──┘  │   │
│  └──────┼────────┼───────┼────────┼────────┼────────┼───────┘   │
│         │        │       │        │        │        │           │
└─────────┼────────┼───────┼────────┼────────┼────────┼───────────┘
          │        │       │        │        │        │
          ▼        ▼       ▼        ▼        ▼        ▼
      ┌───────┐ ┌─────┐ ┌──────┐ ┌─────┐ ┌───────┐ ┌──────────┐
      │本地   │ │远程 │ │远程  │ │远程 │ │IDE    │ │Claude.ai │
      │子进程 │ │SSE  │ │HTTP  │ │WS   │ │Extension│ │Proxy     │
      │Server │ │Server│ │Server│ │Server│ │       │ │Server    │
      └───────┘ └─────┘ └──────┘ └─────┘ └───────┘ └──────────┘
```

### 配置层级

```
┌─────────────────────────────────────┐
│ Enterprise (managed-mcp.json)       │  ← 企业管理配置
├─────────────────────────────────────┤
│ Claude.ai (remote config)           │  ← Claude.ai 远程配置
├─────────────────────────────────────┤
│ Global (~/.claude/mcp.json)         │  ← 用户全局配置
├─────────────────────────────────────┤
│ Project (.claude/mcp.json)          │  ← 项目级配置
├─────────────────────────────────────┤
│ Project (.mcp.json)                 │  ← 项目根目录配置
├─────────────────────────────────────┤
│ Settings (mcpServers in settings)   │  ← 设置中的 MCP 配置
├─────────────────────────────────────┤
│ Plugins (plugin-provided servers)   │  ← 插件提供的 MCP servers
├─────────────────────────────────────┤
│ SDK (dynamic registration)          │  ← SDK 动态注册
└─────────────────────────────────────┘
```

---

## 传输类型

### Transport Schema 定义

```typescript
export const TransportSchema = z.enum([
  'stdio',     // 本地子进程 (stdin/stdout)
  'sse',       // Server-Sent Events
  'sse-ide',   // IDE 扩展专用 SSE (内部)
  'http',      // HTTP Streaming (Streamable HTTP)
  'ws',        // WebSocket
  'sdk',       // SDK Control Transport (进程内)
])
```

### 各传输类型对比

| 传输类型 | 协议 | 认证方式 | 使用场景 |
|----------|------|----------|----------|
| `stdio` | stdin/stdout | 无 (本地进程) | 本地 CLI 工具 |
| `sse` | HTTP SSE | Headers / OAuth | 远程 MCP servers |
| `sse-ide` | HTTP SSE | 无 (信任本地) | VSCode 等 IDE 扩展 |
| `http` | HTTP Streaming | Headers / OAuth | 远程 HTTP servers |
| `ws` | WebSocket | Headers | WebSocket servers |
| `ws-ide` | WebSocket | Token | IDE 扩展 WebSocket |
| `sdk` | 进程内 | 无 | SDK 控制的 servers |
| `claudeai-proxy` | HTTP Proxy | Claude.ai OAuth | Claude.ai 代理 servers |

---

## 类型定义 (types.ts)

### 配置 Scope

```typescript
export const ConfigScopeSchema = z.enum([
  'local',       // 本地配置
  'user',        // 用户级配置
  'project',     // 项目级配置
  'dynamic',     // 动态配置
  'enterprise',  // 企业管理配置
  'claudeai',    // Claude.ai 配置
  'managed',     // 托管配置
])

export type ConfigScope = z.infer<typeof ConfigScopeSchema>
```

### Server 配置 Schemas

#### Stdio Server

```typescript
export const McpStdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(),  // 可选，向后兼容
  command: z.string().min(1),           // 执行命令
  args: z.array(z.string()).default([]),// 命令参数
  env: z.record(z.string(), z.string()).optional(), // 环境变量
})
```

#### SSE Server

```typescript
export const McpSSEServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),    // 外部 headers 生成器
  oauth: McpOAuthConfigSchema().optional(), // OAuth 配置
})
```

#### HTTP Server

```typescript
export const McpHTTPServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
  oauth: McpOAuthConfigSchema().optional(),
})
```

#### WebSocket Server

```typescript
export const McpWebSocketServerConfigSchema = z.object({
  type: z.literal('ws'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
})
```

#### SDK Server

```typescript
export const McpSdkServerConfigSchema = z.object({
  type: z.literal('sdk'),
  name: z.string(),
})
```

#### Claude.ai Proxy Server

```typescript
export const McpClaudeAIProxyServerConfigSchema = z.object({
  type: z.literal('claudeai-proxy'),
  url: z.string(),
  id: z.string(),
})
```

#### OAuth 配置

```typescript
const McpOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  callbackPort: z.number().int().positive().optional(),
  authServerMetadataUrl: z.string().url()
    .startsWith('https://')  // 必须 HTTPS
    .optional(),
  xaa: z.boolean().optional(),  // Cross-App Access (SEP-990)
})
```

### 服务器连接状态

```typescript
export type MCPServerConnection =
  | ConnectedMCPServer    // 已连接
  | FailedMCPServer       // 连接失败
  | NeedsAuthMCPServer    // 需要认证
  | PendingMCPServer      // 待连接/重连中
  | DisabledMCPServer     // 已禁用

// 已连接服务器的完整类型:
export type ConnectedMCPServer = {
  client: Client                    // MCP SDK Client 实例
  name: string                      // 服务器名称
  type: 'connected'
  capabilities: ServerCapabilities  // 服务器能力声明
  serverInfo?: {
    name: string
    version: string
  }
  instructions?: string             // 服务器指令
  config: ScopedMcpServerConfig     // 带 scope 的配置
  cleanup: () => Promise<void>      // 清理函数
}

// 失败的服务器:
export type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
}

// 需要认证的服务器:
export type NeedsAuthMCPServer = {
  name: string
  type: 'needs-auth'
  config: ScopedMcpServerConfig
}

// 待连接/重连中的服务器:
export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}
```

### 序列化类型 (CLI State)

```typescript
export interface MCPCliState {
  clients: SerializedClient[]
  configs: Record<string, ScopedMcpServerConfig>
  tools: SerializedTool[]
  resources: Record<string, ServerResource[]>
  normalizedNames?: Record<string, string>  // 规范化名 → 原始名映射
}

export interface SerializedTool {
  name: string
  description: string
  inputJSONSchema?: { type: 'object'; properties?: Record<string, unknown> }
  isMcp?: boolean
  originalToolName?: string  // MCP server 原始工具名
}
```

### MCP Config JSON 文件

```typescript
export const McpJsonConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema()),
})

export type McpJsonConfig = z.infer<typeof McpJsonConfigSchema>
```

---

## 客户端实现 (client.ts)

### 核心依赖

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
```

### 工具发现

```typescript
// listTools() → ListToolsResult
// 返回工具 schemas，包含:
//   - name: 工具名称
//   - description: 工具描述
//   - inputSchema: JSON Schema 输入定义

// 工具名称规范化:
// MCP 工具名格式: mcp__<server_name>__<tool_name>
import { buildMcpToolName } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
```

### 工具执行

```typescript
// callTool() → CallToolResult
// 结果类型包含:
//   - text content (文本结果)
//   - image content (图片，Base64)
//   - binary content (二进制数据)
//   - resource links (资源链接)

// 大输出处理:
// - 超大输出自动截断 (mcpContentNeedsTruncation)
// - 二进制内容持久化到文件 (persistBinaryContent)
// - 图片自动缩放 (maybeResizeAndDownsampleImageBuffer)
```

### 错误处理

```typescript
// 自定义错误类:

// OAuth 认证失败 (401) → 触发重新认证
export class McpAuthError extends Error

// Session 过期 → 触发重连
export class McpSessionExpiredError extends Error

// 认证流程:
// 1. 初始连接尝试
// 2. 401 错误 → McpAuthError
// 3. 工具执行层捕获 → 更新状态为 'needs-auth'
// 4. 用户/自动重新认证
// 5. 重连
```

### 连接管理

```typescript
// 传输层创建:
// - Stdio: spawn 子进程, 通过 stdin/stdout 通信
// - SSE: HTTP SSE 连接
// - HTTP Streaming: StreamableHTTPClientTransport
// - WebSocket: 自定义 WebSocketTransport
// - SDK Control: SdkControlClientTransport (进程内)

// 连接生命周期:
// 1. 创建 Transport
// 2. 创建 Client 并绑定 Transport
// 3. 连接初始化 (capabilities 协商)
// 4. 工具发现 (listTools)
// 5. 资源发现 (listResources, 如果支持)
// 6. 运行中 (callTool, readResource)
// 7. 断开清理 (cleanup)
```

### Elicitation 处理

```typescript
// 服务器可以向客户端请求用户输入:
import {
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'

// 通过 elicitationHandler.ts 处理:
import {
  type ElicitationWaitingState,
  runElicitationHooks,
  runElicitationResultHooks,
} from './elicitationHandler.js'
```

### Prompts 和 Resources

```typescript
// 获取 Prompts 列表:
// listPrompts() → ListPromptsResult

// 获取 Resources 列表:
// listResources() → ListResourcesResult

// 资源类型:
export type ServerResource = Resource & { server: string }
```

---

## 配置系统 (config.ts)

### 配置加载

```typescript
// 获取所有 MCP 配置 (合并所有来源):
export function getAllMcpConfigs(): Record<string, ScopedMcpServerConfig>

// 检查服务器是否禁用:
export function isMcpServerDisabled(name: string): boolean
```

### 配置来源优先级

1. **Enterprise 管理配置**: `{managedFilePath}/managed-mcp.json`
2. **Claude.ai 远程配置**: 通过 `fetchClaudeAIMcpConfigsIfEligible()` 获取
3. **全局用户配置**: `~/.claude/mcp.json`
4. **项目配置**: `.claude/mcp.json` (项目 `.claude` 目录下)
5. **项目根目录配置**: `.mcp.json` (项目根目录)
6. **Settings 中的 mcpServers**: 来自各级 `settings.json`
7. **Plugin 提供的 servers**: 通过 `getPluginMcpServers()` 获取

### 配置文件格式

```json
// ~/.claude/mcp.json 或 .claude/mcp.json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": {
        "API_KEY": "xxx"
      }
    },
    "remote-server": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": {
        "Authorization": "Bearer token"
      },
      "oauth": {
        "clientId": "my-client-id",
        "callbackPort": 8080,
        "authServerMetadataUrl": "https://auth.example.com/.well-known/oauth-authorization-server"
      }
    },
    "ws-server": {
      "type": "ws",
      "url": "wss://ws.example.com/mcp"
    }
  }
}
```

### settings.json 中的 MCP 配置

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "my-tool-server",
      "args": ["--port", "3000"]
    }
  }
}
```

### 配置写入

```typescript
// 写入 .mcp.json 文件:
// - 保留原文件权限
// - 使用 atomic rename (写入临时文件后 rename)
// - 写入前 fsync 确保数据刷盘
async function writeMcpjsonFile(config: McpJsonConfig): Promise<void>
```

### 环境变量展开

```typescript
// 配置值中的环境变量展开:
import { expandEnvVarsInString } from './envExpansion.js'

// 支持 $VAR 和 ${VAR} 语法
// 示例: "command": "$HOME/.local/bin/my-server"
```

---

## 认证 (auth.ts)

### ClaudeAuthProvider

```typescript
// OAuth 认证提供者，用于远程 MCP servers:
export class ClaudeAuthProvider {
  // - 管理 OAuth token 获取和刷新
  // - 在 401 响应时自动刷新 token
  // - 集成 Claude Code 的 OAuth 系统
}
```

### Step-up Detection

```typescript
// 检测需要额外认证的场景:
export function wrapFetchWithStepUpDetection(fetch: FetchLike): FetchLike

// 当 MCP server 要求更高权限时，
// 自动触发 step-up 认证流程
```

### Discovery without Token

```typescript
// 检查 MCP server 是否有发现能力但缺少 token:
export function hasMcpDiscoveryButNoToken(config: McpServerConfig): boolean
```

### Cross-App Access (XAA)

```typescript
// SEP-990: 跨应用访问
// - xaaIdpLogin.ts: IdP 登录流程
// - xaa.ts: XAA 认证处理
// 配置在服务器级别: oauth.xaa = true
// IdP 连接详情来自 settings.xaaIdp
```

---

## MCP Server 入口 (entrypoints/mcp.ts)

Claude Code 自身可以作为 MCP server 运行，暴露内置工具给其他 MCP 客户端。

### Server 配置

```typescript
const server = new Server(
  {
    name: 'claude/tengu',
    version: MACRO.VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
)
```

### 请求处理

#### ListTools

```typescript
server.setRequestHandler(
  ListToolsRequestSchema,
  async (): Promise<ListToolsResult> => {
    const tools = getTools(toolPermissionContext)
    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema),
        outputSchema: tool.outputSchema
          ? zodToJsonSchema(tool.outputSchema)
          : undefined,
      })),
    }
  },
)
```

#### CallTool

```typescript
server.setRequestHandler(
  CallToolRequestSchema,
  async (request): Promise<CallToolResult> => {
    // 1. 查找工具
    const tool = findToolByName(tools, toolName)
    // 2. 检查权限
    const hasPermissions = hasPermissionsToUseTool(tool, ...)
    // 3. 执行工具
    const result = await tool.call(input, context)
    // 4. 返回结果
    return { content: [{ type: 'text', text: result }] }
  },
)
```

### 传输方式

使用 `StdioServerTransport` (标准输入/输出):

```typescript
const transport = new StdioServerTransport()
await server.connect(transport)
```

### 内置命令

```typescript
const MCP_COMMANDS: Command[] = [review]  // 代码审查命令
```

---

## 辅助模块

### mcpStringUtils.ts

```typescript
// 构建 MCP 工具名: mcp__<server>__<tool>
export function buildMcpToolName(serverName: string, toolName: string): string
```

### normalization.ts

```typescript
// 规范化名称以适配 MCP 命名约束:
export function normalizeNameForMCP(name: string): string
```

### utils.ts

```typescript
// 获取安全的 MCP Base URL (用于日志，脱敏):
export function getLoggingSafeMcpBaseUrl(url: string): string

// 获取项目 MCP server 状态:
export function getProjectMcpServerStatus(name: string): ...

// 判断工具是否来自 MCP server:
export function isToolFromMcpServer(tool: Tool): boolean
```

### channelPermissions.ts / channelAllowlist.ts

```typescript
// MCP channel 权限控制:
// - channelPermissions: 管理各 channel 的权限
// - channelAllowlist: 管理允许的 channel 列表
```

### channelNotification.ts

```typescript
// MCP channel 通知处理
```

### headersHelper.ts

```typescript
// 获取 MCP server 的自定义 headers:
export function getMcpServerHeaders(config: McpServerConfig): Promise<Headers>
// 支持 headersHelper 外部脚本生成 headers
```

### officialRegistry.ts

```typescript
// 官方 MCP server 注册表:
export function isOfficialMcpUrl(url: string): boolean
```

### InProcessTransport.ts

```typescript
// 进程内 Transport，用于单元测试和嵌入式场景
```

### SdkControlTransport.ts

```typescript
// SDK 控制 Transport:
export class SdkControlClientTransport {
  // 用于 SDK 模式下的进程内 MCP 通信
}
```

### useManageMCPConnections.ts

```typescript
// React hook，管理 MCP 连接的生命周期
// 用于 TUI (Terminal User Interface)
```

---

## 配置示例

### 最小化 Stdio 配置

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

### 带 OAuth 的 HTTP 配置

```json
{
  "mcpServers": {
    "my-saas-tool": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "oauth": {
        "clientId": "claude-code",
        "callbackPort": 9876,
        "authServerMetadataUrl": "https://auth.example.com/.well-known/oauth-authorization-server"
      }
    }
  }
}
```

### 带环境变量的配置

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx"
      }
    }
  }
}
```

### WebSocket 配置

```json
{
  "mcpServers": {
    "realtime-data": {
      "type": "ws",
      "url": "wss://data.example.com/mcp",
      "headers": {
        "Authorization": "Bearer my-token"
      }
    }
  }
}
```

### 企业管理配置

企业管理配置文件位于 `{managedFilePath}/managed-mcp.json`，格式与标准 MCP 配置相同，但由企业 IT 部门统一管理。

```json
{
  "mcpServers": {
    "internal-kb": {
      "type": "http",
      "url": "https://internal-api.corp.example.com/mcp",
      "headers": {
        "X-Corp-Auth": "auto"
      }
    }
  }
}
```
