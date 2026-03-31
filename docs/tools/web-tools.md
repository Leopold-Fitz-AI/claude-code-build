# Claude Code Web 及网络工具

本文档描述 Web 访问工具、搜索工具以及 MCP (Model Context Protocol) 相关工具。

---

## 1. WebFetchTool

**名称**: `WebFetch` | **文件**: `src/tools/WebFetchTool/WebFetchTool.ts`

获取 URL 内容并将 HTML 转换为 Markdown，再用模型处理。

### 输入参数

```typescript
z.strictObject({
  url: z.string().url(),     // 要获取的 URL（必须合法 URL）
  prompt: z.string(),        // 对获取内容执行的 prompt
})
```

### 输出

```typescript
type Output = {
  bytes: number          // 获取内容大小（字节）
  code: number           // HTTP 状态码
  codeText: string       // HTTP 状态码文本
  result: string         // 用 prompt 处理后的结果
  durationMs: number     // 获取和处理耗时（毫秒）
  url: string            // 实际获取的 URL
}
```

### 执行流程

1. **URL 获取**: `getURLMarkdownContent()` 获取页面内容
2. **HTML 转 Markdown**: 将 HTML 内容转换为 Markdown 格式
3. **Prompt 处理**: `applyPromptToMarkdown()` 使用模型对 Markdown 内容执行 prompt
4. **结果限制**: `MAX_MARKDOWN_LENGTH` 限制内容大小

### 权限机制

WebFetchTool 采用基于域名的权限系统：

```typescript
function webFetchToolInputToPermissionRuleContent(input): string {
  const hostname = new URL(url).hostname
  return `domain:${hostname}`  // 权限规则格式: "domain:<hostname>"
}
```

#### 预审批域名 (`preapproved.ts`)

预审批域名列表是一组代码相关的知名网站，无需用户确认即可访问：

```typescript
export const PREAPPROVED_HOSTS = new Set([
  // Anthropic
  'platform.claude.com',
  'code.claude.com',
  'modelcontextprotocol.io',
  'agentskills.io',

  // 编程语言文档
  'docs.python.org',           // Python
  'en.cppreference.com',       // C/C++
  'developer.mozilla.org',     // MDN (JavaScript/Web APIs)
  'doc.rust-lang.org',         // Rust
  'go.dev', 'pkg.go.dev',     // Go
  'www.typescriptlang.org',   // TypeScript
  // ... 更多语言

  // Web 框架
  'react.dev',                 // React
  'nextjs.org',                // Next.js
  'vuejs.org',                 // Vue.js
  'angular.io',                // Angular
  'tailwindcss.com',           // Tailwind CSS
  // ... 更多框架

  // 数据库
  'www.postgresql.org',        // PostgreSQL
  'www.mongodb.com',           // MongoDB
  'redis.io',                  // Redis
  // ... 更多数据库

  // 云服务
  'docs.aws.amazon.com',       // AWS
  'cloud.google.com',          // Google Cloud
  'kubernetes.io',             // Kubernetes
  // ... 更多云服务
])
```

**安全警告**: 这些预审批域名**仅限 WebFetch 的 GET 请求**使用。沙箱系统不继承此列表，
因为某些域名（如 `huggingface.co`、`nuget.org`）允许文件上传，不适合无限制网络访问。

#### 预审批匹配逻辑

```typescript
function isPreapprovedHost(hostname: string, pathname: string): boolean {
  // 1. 精确主机名匹配
  if (HOSTNAME_ONLY.has(hostname)) return true
  // 2. 路径前缀匹配（如 "github.com/anthropics"）
  //    强制路径段边界："/anthropics" 不匹配 "/anthropics-evil"
  if (prefixes && pathname.startsWith(prefix + '/')) return true
  return false
}
```

### 权限规则匹配

```typescript
// 用户的权限规则使用 "domain:<hostname>" 格式
// 例如: WebFetch("domain:example.com") → 允许访问 example.com
```

### 工具特性

```typescript
shouldDefer: true              // 延迟加载
maxResultSizeChars: 100_000
isConcurrencySafe: false       // 默认
isReadOnly: false              // 默认（实际上是只读操作，但保持默认）
```

---

## 2. WebSearchTool

**名称**: `WebSearch` | **文件**: `src/tools/WebSearchTool/WebSearchTool.ts`

基于 Anthropic Web Search API 的网页搜索工具，使用模型作为中介处理搜索结果。

### 输入参数

```typescript
z.strictObject({
  query: z.string().min(2),                          // 搜索查询（最少 2 字符）
  allowed_domains: z.array(z.string()).optional(),   // 仅包含这些域名的结果
  blocked_domains: z.array(z.string()).optional(),   // 排除这些域名的结果
})
```

### 输出

```typescript
type Output = {
  query: string              // 执行的搜索查询
  results: Array<            // 搜索结果数组
    SearchResult | string    // 结构化结果或文本评论
  >
  durationSeconds: number    // 搜索耗时（秒）
}

type SearchResult = {
  tool_use_id: string
  content: Array<{
    title: string            // 搜索结果标题
    url: string              // 搜索结果 URL
  }>
}
```

### 搜索架构

WebSearchTool 不直接调用搜索引擎，而是使用 Anthropic 的 `web_search_20250305` API tool：

```typescript
function makeToolSchema(input: Input): BetaWebSearchTool20250305 {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: input.allowed_domains,
    blocked_domains: input.blocked_domains,
  }
}
```

### 执行流程

1. 构建 `web_search_20250305` tool schema
2. 使用 `queryModelWithStreaming()` 调用带搜索能力的模型
3. 模型自动执行搜索并返回结构化结果
4. 提取搜索结果（`BetaServerToolUseBlock`）和文本块
5. 报告进度（`WebSearchProgress` 类型）

### 进度事件

```typescript
type WebSearchProgress = {
  type: 'web_search_progress'
  query: string
  results: Array<SearchResult | string>
  durationSeconds: number
}
```

### 工具特性

```typescript
shouldDefer: false
isConcurrencySafe: true
isReadOnly: true
maxResultSizeChars: 100_000  // 默认
```

---

## 3. MCP 工具

### MCPTool（通用包装器）

**名称**: `mcp` (运行时覆盖) | **文件**: `src/tools/MCPTool/MCPTool.ts`

MCPTool 是所有 MCP 工具的基础模板。实际使用时，`mcpClient.ts` 会创建 MCPTool 的克隆并覆盖关键方法。

```typescript
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',                    // 运行时被覆盖为 mcp__<server>__<tool>
  maxResultSizeChars: 100_000,

  // 输入 schema 为任意对象（MCP 工具自定义 schema）
  get inputSchema() {
    return z.object({}).passthrough()
  },

  // MCP 特有权限：passthrough（交由通用权限系统处理）
  async checkPermissions(): Promise<PermissionResult> {
    return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
  },

  // 以下方法在 mcpClient.ts 中被覆盖：
  // - name
  // - description
  // - prompt
  // - call
  // - userFacingName
  // - isOpenWorld
})
```

### MCP 工具命名约定

MCP 工具的名称格式：`mcp__<serverName>__<toolName>`

在 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` 模式下可使用无前缀名称。

### MCP 工具元数据

```typescript
mcpInfo?: {
  serverName: string    // MCP 服务器名称（未规范化）
  toolName: string      // MCP 工具名称（未规范化）
}
```

### 折叠分类 (`classifyForCollapse.ts`)

MCP 工具支持 UI 折叠分类，根据工具输出判断是搜索、读取还是列表操作。

### ListMcpResourcesTool

**名称**: `ListMcpResources` | **文件**: `src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts`

列出 MCP 服务器提供的资源列表。

```typescript
// 输入: 无特殊参数
// 输出: MCP 服务器资源列表
```

### ReadMcpResourceTool

**名称**: `ReadMcpResource` | **文件**: `src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts`

读取 MCP 服务器上的特定资源。

```typescript
// 输入: 资源 URI
// 输出: 资源内容
```

### MCP 资源工具的位置

`ListMcpResourcesTool` 和 `ReadMcpResourceTool` 属于"特殊工具"，不在 `getTools()` 的默认结果中，
而是根据 MCP 连接状态条件性添加。

---

## 4. McpAuthTool

**名称**: `McpAuth` | **文件**: `src/tools/McpAuthTool/McpAuthTool.ts`

MCP 服务器 OAuth 认证工具。当 MCP 服务器需要 OAuth 流程认证时使用。

### 触发场景

当 MCP 工具调用返回 `-32042` 错误码时，表示需要 URL elicitation 认证流程。
此时通过 `handleElicitation` 回调处理认证。

```typescript
// ToolUseContext 中的 elicitation 处理器
handleElicitation?: (
  serverName: string,
  params: ElicitRequestURLParams,
  signal: AbortSignal,
) => Promise<ElicitResult>
```

---

## Web 工具安全模型

### 权限层次

```
┌─────────────────────────────────────────────┐
│  1. 预审批域名（PREAPPROVED_HOSTS）          │
│     → 自动允许 WebFetch GET 请求              │
├─────────────────────────────────────────────┤
│  2. 用户提供的域名                            │
│     → 从用户消息中提取的 URL 域名              │
├─────────────────────────────────────────────┤
│  3. 权限规则匹配                              │
│     → domain:<hostname> 模式                  │
├─────────────────────────────────────────────┤
│  4. 用户确认                                  │
│     → 首次访问未知域名时请求许可               │
└─────────────────────────────────────────────┘
```

### 沙箱隔离

WebFetch 的预审批域名**不**传递给沙箱的网络限制。沙箱中的网络访问（BashTool 等）
需要显式用户权限规则，因为这些工具可执行 POST/上传等危险操作。

---

## 相关文件路径

- WebFetchTool: `/src/tools/WebFetchTool/WebFetchTool.ts`
  - `preapproved.ts` — 预审批域名列表
  - `utils.ts` — HTML 转 Markdown、URL 处理
  - `prompt.ts` — 工具 prompt
- WebSearchTool: `/src/tools/WebSearchTool/WebSearchTool.ts`
  - `prompt.ts` — 搜索 prompt
- MCPTool: `/src/tools/MCPTool/MCPTool.ts`
  - `classifyForCollapse.ts` — UI 折叠分类
  - `prompt.ts` — MCP 工具 prompt
- ListMcpResourcesTool: `/src/tools/ListMcpResourcesTool/`
- ReadMcpResourceTool: `/src/tools/ReadMcpResourceTool/`
- McpAuthTool: `/src/tools/McpAuthTool/McpAuthTool.ts`
- MCP 客户端: `/src/services/mcp/client.ts`
- MCP 类型: `/src/services/mcp/types.ts`
