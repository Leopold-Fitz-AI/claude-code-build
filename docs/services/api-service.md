# API 服务架构

> Claude Code 与 Anthropic API 交互的核心服务层文档。
> 源码路径: `src/services/api/`

---

## 目录

- [总体架构](#总体架构)
- [客户端工厂 (client.ts)](#客户端工厂-clientts)
- [主 API 交互 (claude.ts)](#主-api-交互-claudets)
- [Bootstrap 引导 (bootstrap.ts)](#bootstrap-引导-bootstrapts)
- [错误处理 (errors.ts)](#错误处理-errorsts)
- [重试逻辑 (withRetry.ts)](#重试逻辑-withretryts)
- [日志与网关检测 (logging.ts)](#日志与网关检测-loggingts)
- [文件 API (filesApi.ts)](#文件-api-filesapits)
- [Prompt Cache 检测 (promptCacheBreakDetection.ts)](#prompt-cache-检测-promptcachebreakdetectionts)
- [Session Ingress (sessionIngress.ts)](#session-ingress-sessioningressts)

---

## 总体架构

```
┌──────────────────────────────────────────────────────────┐
│                    应用层 (REPL / SDK / MCP)              │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│               claude.ts  (queryClaudeWithMessages)       │
│  ┌─────────────┐ ┌───────────┐ ┌──────────────────────┐ │
│  │ streaming    │ │ thinking  │ │ tool execution loop  │ │
│  └─────────────┘ └───────────┘ └──────────────────────┘ │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│            withRetry.ts  (指数退避 + 重试策略)            │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│              client.ts  (客户端工厂)                      │
│  ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────┐  │
│  │ Direct   │ │ Bedrock │ │ Vertex  │ │  Foundry     │  │
│  │ API      │ │ (AWS)   │ │ (GCP)   │ │  (Azure)     │  │
│  └──────────┘ └─────────┘ └─────────┘ └──────────────┘  │
└──────────────────────────────────────────────────────────┘
                         │
             ┌───────────┼───────────────┐
             ▼           ▼               ▼
      ┌──────────┐ ┌──────────┐  ┌──────────────┐
      │errors.ts │ │logging.ts│  │bootstrap.ts  │
      └──────────┘ └──────────┘  └──────────────┘
```

---

## 客户端工厂 (client.ts)

`getAnthropicClient()` 是创建 API 客户端的核心函数。根据环境变量自动选择对应的 provider 后端。

### 函数签名

```typescript
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic>
```

### Provider 选择逻辑

通过环境变量判断 provider:

| Provider | 环境变量开关 | SDK 类 |
|----------|-------------|--------|
| Direct API (第一方) | 默认 | `Anthropic` |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | `AnthropicBedrock` |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` | `AnthropicVertex` |
| Azure Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` | `AnthropicFoundry` |

### Direct API 认证

```
┌─ OAuth 用户 (ClaudeAI 订阅者)
│  └─ authToken: getClaudeAIOAuthTokens().accessToken
│
└─ API Key 用户
   └─ apiKey: ANTHROPIC_API_KEY 或 getAnthropicApiKey()
      └─ 附加: ANTHROPIC_AUTH_TOKEN (Bearer header)
         或: API Key Helper (非交互式会话)
```

**环境变量:**

| 变量名 | 说明 |
|--------|------|
| `ANTHROPIC_API_KEY` | 直连 API 密钥 |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token 认证 |
| `API_TIMEOUT_MS` | 请求超时时间，默认 600000ms (10 分钟) |
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义请求头 (格式: `Name: Value`，多行分隔) |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | 启用额外保护 header |

### AWS Bedrock 认证

```typescript
// 区域选择优先级:
// 1. ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION (仅用于小快模型)
// 2. AWS_REGION / AWS_DEFAULT_REGION
// 3. 默认: us-east-1

// 认证方式 (按优先级):
// 1. AWS_BEARER_TOKEN_BEDROCK → Bearer token, skipAuth=true
// 2. refreshAndGetAwsCredentials() → accessKeyId, secretAccessKey, sessionToken
// 3. CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 → 跳过认证 (测试/代理场景)
```

**环境变量:**

| 变量名 | 说明 |
|--------|------|
| `CLAUDE_CODE_USE_BEDROCK` | 启用 Bedrock 后端 |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS 区域 (默认 `us-east-1`) |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` | Haiku 模型的区域覆盖 |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API Key 认证的 Bearer token |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | 跳过 Bedrock 认证 |

### Google Vertex AI 认证

```typescript
// 区域选择优先级:
// 1. VERTEX_REGION_CLAUDE_3_5_HAIKU (模型特定区域变量)
// 2. VERTEX_REGION_CLAUDE_HAIKU_4_5
// 3. VERTEX_REGION_CLAUDE_3_5_SONNET
// 4. VERTEX_REGION_CLAUDE_3_7_SONNET
// 5. CLOUD_ML_REGION (全局 GCP 区域)
// 6. 默认区域配置
// 7. 最终回退: us-east5

// GoogleAuth 配置:
// - scopes: ['https://www.googleapis.com/auth/cloud-platform']
// - projectId 回退: ANTHROPIC_VERTEX_PROJECT_ID (避免 12s metadata server 超时)
```

**环境变量:**

| 变量名 | 说明 |
|--------|------|
| `CLAUDE_CODE_USE_VERTEX` | 启用 Vertex AI 后端 |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP 项目 ID (必需) |
| `CLOUD_ML_REGION` | 全局 GCP 区域 |
| `VERTEX_REGION_CLAUDE_*` | 模型特定区域 |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | 跳过 Vertex 认证 |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCP 凭证文件路径 |

### Azure Foundry 认证

```typescript
// 认证方式:
// 1. ANTHROPIC_FOUNDRY_API_KEY → SDK 默认读取
// 2. CLAUDE_CODE_SKIP_FOUNDRY_AUTH=1 → Mock token provider (测试/代理)
// 3. DefaultAzureCredential → Azure AD 认证
//    scope: 'https://cognitiveservices.azure.com/.default'
```

**环境变量:**

| 变量名 | 说明 |
|--------|------|
| `CLAUDE_CODE_USE_FOUNDRY` | 启用 Foundry 后端 |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Azure 资源名称 |
| `ANTHROPIC_FOUNDRY_BASE_URL` | 完整 Base URL 覆盖 |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry API 密钥 |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | 跳过 Foundry 认证 |

### 请求头注入

每个请求自动附加以下 headers:

```typescript
const defaultHeaders = {
  'x-app': 'cli',
  'User-Agent': getUserAgent(),
  'X-Claude-Code-Session-Id': getSessionId(),
  // 条件性 headers:
  'x-claude-remote-container-id': CLAUDE_CODE_CONTAINER_ID,
  'x-claude-remote-session-id': CLAUDE_CODE_REMOTE_SESSION_ID,
  'x-client-app': CLAUDE_AGENT_SDK_CLIENT_APP,
  'x-anthropic-additional-protection': 'true', // 当启用时
}
```

### Client Request ID

`buildFetch()` 为第一方 API 请求自动注入 `x-client-request-id` (UUID v4)，用于关联超时请求与服务端日志:

```typescript
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
```

---

## 主 API 交互 (claude.ts)

`claude.ts` 是与 Claude 模型交互的核心模块，包含消息查询、streaming、tool 执行循环、thinking mode 和 fast mode 等功能。

### 核心导入

```typescript
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaToolUnion,
  BetaUsage,
  MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
```

### 关键功能

- **queryClaudeWithMessages()**: 主入口函数，构建完整请求参数并处理 streaming 响应
- **Streaming 处理**: 基于 `BetaRawMessageStreamEvent` 流式处理响应
- **Tool 执行**: 自动检测工具调用并执行，维护工具权限上下文 `ToolPermissionContext`
- **Thinking Mode**: 支持 thinking/budget tokens 配置 (`ThinkingConfig`)
- **Fast Mode**: 通过 `isFastModeEnabled()` 控制，支持 cooldown 和 fallback 机制
- **Beta Headers**: 动态构建 beta headers (context-1m, effort, caching-scope, structured-outputs 等)

### 额外请求体参数

```typescript
// 通过 CLAUDE_CODE_EXTRA_BODY 环境变量注入额外参数:
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject
```

### 缓存策略

```typescript
type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'
```

---

## Bootstrap 引导 (bootstrap.ts)

应用启动时获取服务端配置数据。

### 类型定义

```typescript
const bootstrapResponseSchema = z.object({
  client_data: z.record(z.unknown()).nullish(),
  additional_model_options: z.array(
    z.object({
      model: z.string(),   // → value
      name: z.string(),    // → label
      description: z.string(),
    })
  ).nullish(),
})

type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>
```

### 认证流程

```
fetchBootstrapAPI()
  ├─ 检查 isEssentialTrafficOnly() → 跳过
  ├─ 检查 getAPIProvider() !== 'firstParty' → 跳过
  ├─ OAuth 优先 (需要 user:profile scope)
  │   └─ Authorization: Bearer <accessToken>
  └─ 回退至 API Key
      └─ x-api-key: <apiKey>
```

**API 端点**: `{BASE_API_URL}/api/claude_cli/bootstrap`

---

## 错误处理 (errors.ts)

### classifyAPIError()

将 API 错误分类为用户可读的消息。

### 错误类型

| 错误类型 | HTTP 状态码 | 说明 |
|----------|------------|------|
| Rate Limit | 429 | 速率限制，根据订阅类型展示不同消息 |
| Overloaded | 529 | 服务过载 |
| Auth Error | 401 | 认证失败 |
| Token Revoked | 403 | OAuth token 已吊销 |
| Prompt Too Long | 400 | 输入超长 |
| Connection Error | - | 网络连接问题 |
| Timeout | 408 | 请求超时 |

### Prompt 过长解析

```typescript
// 从错误消息中提取 token 数量:
// "prompt is too long: 137500 tokens > 135000 maximum"
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
}

// 计算超出 token 数量:
export function getPromptTooLongOverTokens(msg: AssistantMessage): number | undefined
```

### 关键常量

```typescript
export const API_ERROR_MESSAGE_PREFIX = 'API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
export const REPEATED_529_ERROR_MESSAGE = // 重复 529 错误消息
```

---

## 重试逻辑 (withRetry.ts)

### 核心函数

```typescript
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T>
```

`withRetry` 是一个 AsyncGenerator，在重试等待期间 yield `SystemAPIErrorMessage` 对象，供 UI 层显示重试状态。

### 重试上下文

```typescript
export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number           // 默认 10
  model: string
  fallbackModel?: string        // 529 后的回退模型
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  initialConsecutive529Errors?: number
}
```

### 重试策略

```
┌────────────────────────────────────────────────────────────┐
│                    withRetry 决策树                         │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  信号已中止? ─── 是 ──→ throw APIUserAbortError            │
│       │                                                    │
│      否                                                    │
│       │                                                    │
│  Fast Mode 活跃 + 429/529?                                 │
│  ├─ retry-after < 20s ──→ 等待后重试 (保持 fast mode)       │
│  ├─ retry-after >= 20s ──→ 进入 cooldown (切回标准速度)     │
│  └─ overage 被拒 ──→ 永久禁用 fast mode                    │
│                                                            │
│  529 非前台请求? ──→ 立即丢弃 (不重试)                      │
│                                                            │
│  连续 529 >= 3 次?                                         │
│  ├─ 有 fallbackModel ──→ throw FallbackTriggeredError      │
│  └─ 无 fallback ──→ throw CannotRetryError                 │
│                                                            │
│  Persistent 模式 (CLAUDE_CODE_UNATTENDED_RETRY)?           │
│  └─ 429/529 无限重试, 最大退避 5 分钟, 每 30s 心跳         │
│                                                            │
│  认证错误?                                                  │
│  ├─ 401 ──→ 刷新 OAuth token, 重建客户端                   │
│  ├─ 403 token revoked ──→ 同上                             │
│  ├─ Bedrock auth error ──→ 清除 AWS 凭证缓存               │
│  └─ Vertex auth error ──→ 清除 GCP 凭证缓存               │
│                                                            │
│  ECONNRESET/EPIPE ──→ 禁用 keep-alive, 重建客户端          │
│                                                            │
│  Context overflow (400)?                                    │
│  └─ 调整 maxTokensOverride, 重试                           │
│                                                            │
│  其他可重试错误 ──→ 指数退避                                │
└────────────────────────────────────────────────────────────┘
```

### 退避公式

```typescript
export const BASE_DELAY_MS = 500

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  // 优先使用 retry-after header
  if (retryAfterHeader) return parseInt(retryAfterHeader) * 1000

  // 指数退避 + 25% 抖动
  const baseDelay = Math.min(BASE_DELAY_MS * 2^(attempt-1), maxDelayMs)
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}
```

### 可重试状态码

| 状态码 | 条件 | 说明 |
|--------|------|------|
| 401 | 总是 | 清除 API Key 缓存后重试 |
| 403 | Token revoked | 刷新 OAuth token |
| 408 | 总是 | 请求超时 |
| 409 | 总是 | Lock 超时 |
| 429 | 非 ClaudeAI 订阅用户或企业用户 | 速率限制 |
| 500+ | 总是 | 服务端错误 |
| 529 | 前台请求 | 服务过载 |

### Fast Mode Cooldown 常量

```typescript
const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000  // 30 分钟
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000                  // 20 秒
const MIN_COOLDOWN_MS = 10 * 60 * 1000                      // 10 分钟
```

### 自定义错误类

```typescript
export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  )
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  )
}
```

---

## 日志与网关检测 (logging.ts)

### 网关检测

通过响应 headers 自动检测 AI 网关代理:

```typescript
type KnownGateway =
  | 'litellm'
  | 'helicone'
  | 'portkey'
  | 'cloudflare-ai-gateway'
  | 'kong'
  | 'braintrust'
  | 'databricks'

// 通过 header 前缀匹配:
const GATEWAY_FINGERPRINTS = {
  litellm:    { prefixes: ['x-litellm-'] },
  helicone:   { prefixes: ['helicone-'] },
  portkey:    { prefixes: ['x-portkey-'] },
  // ...
}
```

### 缓存策略类型

```typescript
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'
```

### 日志事件

- `logAPIQuery()`: 记录 API 请求元数据
- `logAPISuccessAndDuration()`: 记录成功响应及耗时
- `logAPIError()`: 记录 API 错误 (调用 `classifyAPIError()`)

---

## 文件 API (filesApi.ts)

用于从 Anthropic Public Files API 下载和上传文件附件。

### 类型定义

```typescript
// 文件规格 (来自 CLI --file=<fileId>:<relativePath>)
export type File = {
  fileId: string
  relativePath: string
}

export type FilesApiConfig = {
  oauthToken: string    // OAuth token (来自 session JWT)
  baseUrl?: string      // 默认: https://api.anthropic.com
  sessionId: string     // 会话 ID
}

export type DownloadResult = {
  fileId: string
  path: string
  success: boolean
  error?: string
  bytesWritten?: number
}
```

### 配置

```typescript
const FILES_API_BETA_HEADER = 'files-api-2025-04-14,oauth-2025-04-20'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_RETRIES = 3
```

### API Base URL 解析

```typescript
// 优先级:
// 1. ANTHROPIC_BASE_URL
// 2. CLAUDE_CODE_API_BASE_URL
// 3. 'https://api.anthropic.com'
```

---

## Prompt Cache 检测 (promptCacheBreakDetection.ts)

两阶段检测机制，诊断 prompt cache 失效原因。

### 第一阶段: recordPromptState() (请求前)

```typescript
export type PromptStateSnapshot = {
  system: TextBlockParam[]
  toolSchemas: BetaToolUnion[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  fastMode?: boolean
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  isUsingOverage?: boolean
  cachedMCEnabled?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

export function recordPromptState(snapshot: PromptStateSnapshot): void
```

记录当前 prompt/tool 状态，对比上次状态检测变化。

### 第二阶段: checkResponseForCacheBreak() (请求后)

```typescript
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
): Promise<void>
```

检测条件: cache read tokens 下降 >5% 且绝对下降 >2000 tokens。

### 跟踪的变化因素

| 因素 | 说明 |
|------|------|
| `systemPromptChanged` | 系统 prompt 文本变化 |
| `toolSchemasChanged` | 工具 schema 变化 |
| `modelChanged` | 模型切换 |
| `fastModeChanged` | fast mode 切换 |
| `cacheControlChanged` | cache_control scope/TTL 变化 |
| `globalCacheStrategyChanged` | 全局缓存策略变化 |
| `betasChanged` | beta headers 变化 |
| `autoModeChanged` | auto mode 切换 |
| `effortChanged` | effort 级别变化 |
| `extraBodyChanged` | 额外请求体参数变化 |

### TTL 检测

```typescript
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000    // 5 分钟 TTL
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000  // 1 小时 TTL
```

当所有客户端标记均无变化时:
- 时间间隔 >1h → "possible 1h TTL expiry"
- 时间间隔 >5min → "possible 5min TTL expiry"
- 时间间隔 <5min → "likely server-side"

---

## Session Ingress (sessionIngress.ts)

远程会话持久化服务，使用乐观并发控制 (Optimistic Concurrency Control)。

### 核心函数

```typescript
// 追加会话日志条目 (顺序执行，基于 JWT 认证)
export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean>

// 获取全部会话日志 (用于 hydration)
export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null>

// 通过 OAuth 获取会话日志 (Teleport 场景)
export async function getSessionLogsViaOAuth(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null>

// CCR v2 Sessions API (替代 session-ingress)
export async function getTeleportEvents(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null>
```

### 并发控制

```
appendSessionLog()
  └─ 每个 session 有独立的 sequential wrapper
      └─ Last-Uuid header 乐观锁
          ├─ 200/201 → 成功，更新 lastUuid
          ├─ 409 → 冲突
          │   ├─ 我方 entry 已存在 → 恢复状态
          │   └─ 他方 writer → 采纳 server 的 lastUuid
          ├─ 401 → 不可重试
          └─ 其他 → 指数退避重试 (最多 10 次)
```

### Teleport Events (v2 API)

```typescript
// 分页获取 (每页最多 1000 条，最多 100 页)
// 端点: GET /v1/code/sessions/{id}/teleport-events
// 使用 cursor-based 分页
type TeleportEventsResponse = {
  data: Array<{
    event_id: string
    event_type: string
    is_compaction: boolean
    payload: Entry | null
    created_at: string
  }>
  next_cursor?: string  // 末页时为 null/undefined
}
```

### 重试配置

```typescript
const MAX_RETRIES = 10
const BASE_DELAY_MS = 500
// 退避公式: min(500 * 2^(attempt-1), 8000)
```

---

## 环境变量一览

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ANTHROPIC_API_KEY` | 直连 API 密钥 | - |
| `CLAUDE_CODE_USE_BEDROCK` | 启用 AWS Bedrock | `false` |
| `CLAUDE_CODE_USE_VERTEX` | 启用 Google Vertex AI | `false` |
| `CLAUDE_CODE_USE_FOUNDRY` | 启用 Azure Foundry | `false` |
| `AWS_REGION` | AWS 区域 | `us-east-1` |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP 项目 ID | - |
| `CLOUD_ML_REGION` | GCP 区域 | `us-east5` |
| `API_TIMEOUT_MS` | API 超时 | `600000` |
| `CLAUDE_CODE_MAX_RETRIES` | 最大重试次数 | `10` |
| `CLAUDE_CODE_UNATTENDED_RETRY` | 无人值守无限重试 | `false` |
| `CLAUDE_CODE_EXTRA_BODY` | 额外请求体 (JSON) | - |
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义 headers | - |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | 额外保护 | `false` |
| `ANTHROPIC_BASE_URL` | API Base URL 覆盖 | - |
| `FALLBACK_FOR_ALL_PRIMARY_MODELS` | 允许所有主模型回退 | - |
