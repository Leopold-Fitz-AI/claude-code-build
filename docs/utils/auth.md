# 认证系统

本文档详细描述 Claude Code 的认证体系，涵盖 OAuth 流程、API key 管理、第三方云提供商集成和认证状态检测。

---

## 认证架构概览

Claude Code 支持多种认证方式，按优先级排列：

```
1. OAuth (Claude.ai 订阅用户)      — 主要认证方式
2. API Key (Console 用户)           — ANTHROPIC_API_KEY 或 apiKeyHelper
3. File Descriptor Token            — CCR/Claude Desktop 传递的 OAuth token
4. 第三方提供商凭证                  — Bedrock (AWS), Vertex (Google), Foundry (Azure)
```

---

## OAuth 流程

### 概述

OAuth 是 Claude.ai 订阅用户（Pro/Max/Team/Enterprise）的主要认证方式。Claude Code 实现了完整的 OAuth 2.0 Authorization Code Flow with PKCE。

### OAuth 配置 (`src/constants/oauth.ts`)

**生产环境配置：**

| 配置项 | 值 |
|--------|------|
| `CLIENT_ID` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| `BASE_API_URL` | `https://api.anthropic.com` |
| `CONSOLE_AUTHORIZE_URL` | `https://platform.claude.com/oauth/authorize` |
| `CLAUDE_AI_AUTHORIZE_URL` | `https://claude.com/cai/oauth/authorize` |
| `TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` |
| `MCP_PROXY_URL` | `https://mcp-proxy.anthropic.com` |

### OAuth Scopes

#### Claude.ai 订阅用户 Scopes

```typescript
const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',               // 用户资料访问
  'user:inference',             // 推理 API 调用
  'user:sessions:claude_code',  // Claude Code 会话管理
  'user:mcp_servers',           // MCP 服务器访问
  'user:file_upload',           // 文件上传
]
```

#### Console 用户 Scopes

```typescript
const CONSOLE_OAUTH_SCOPES = [
  'org:create_api_key',         // 创建 API key
  'user:profile',               // 用户资料访问
]
```

#### 统一 Scopes（登录时请求）

```typescript
const ALL_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'org:create_api_key',
]
```

### Token 管理

#### Token 存储

OAuth tokens 存储在 `~/.claude/config.json` 中：

```json
{
  "auth": {
    "oauthTokens": {
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": 1234567890,
      "scopes": ["user:inference", "user:profile", ...]
    }
  }
}
```

#### Token 刷新 (`src/services/oauth/client.ts`)

```typescript
function isOAuthTokenExpired(tokens: OAuthTokens): boolean
// 检查 access token 是否过期

async function refreshOAuthToken(tokens: OAuthTokens): Promise<OAuthTokens>
// 使用 refresh token 获取新的 access token

function shouldUseClaudeAIAuth(scopes?: string[]): boolean
// 检查 scopes 是否包含 inference scope，决定是否使用 Claude.ai 认证
```

### OAuth Beta Header

```typescript
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
// 在使用 OAuth 认证时附加到 API 请求中
```

### MCP OAuth (SEP-991)

MCP 服务器认证使用 Client ID Metadata Document：

```typescript
const MCP_CLIENT_METADATA_URL = 'https://claude.ai/oauth/claude-code-client-metadata'
// 当 MCP auth server 支持 client_id_metadata_document 时使用
```

---

## API Key 管理

### API Key 来源优先级

```typescript
function getAnthropicApiKeyWithSource(): { key: string | null; source: ApiKeySource }
```

**来源优先级（从高到低）：**

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `ANTHROPIC_API_KEY` | 环境变量 |
| 2 | `apiKeyHelper` | 设置中配置的脚本 |
| 3 | `File Descriptor` | `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` 环境变量指定的 FD |
| 4 | `/login managed key` | 通过 `/login` 命令保存的 key |

### ApiKeySource 类型

```typescript
type ApiKeySource =
  | 'ANTHROPIC_API_KEY'       // 环境变量
  | 'apiKeyHelper'            // 脚本获取
  | '/login managed key'      // 登录管理的 key
  | 'none'                    // 无 API key
```

### Keychain 集成 (macOS)

在 macOS 上，API key 存储在系统 Keychain 中：

```typescript
// src/utils/secureStorage/macOsKeychainHelpers.ts
function getMacOsKeychainStorageServiceName(): string
// Keychain 服务名称

// src/utils/secureStorage/keychainPrefetch.ts
// 启动时预取 keychain 中的 API key，避免首次调用延迟
```

### apiKeyHelper 机制

用户可以在 `settings.json` 中配置 `apiKeyHelper` 字段，指向一个脚本，该脚本的输出作为 API key：

```json
{
  "apiKeyHelper": "/path/to/get-api-key.sh"
}
```

**缓存策略**：
- 默认 TTL：5 分钟 (`DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000`)
- 使用 `memoizeWithTTLAsync` 缓存结果

### File Descriptor Token

CCR (Claude Code Remote) 和 Claude Desktop 通过文件描述符传递 OAuth token：

```typescript
// 环境变量：
// CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR — API key 的文件描述符
// CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR — OAuth token 的文件描述符

function getApiKeyFromFileDescriptor(): string | null
function getOAuthTokenFromFileDescriptor(): string | null
```

---

## 第三方提供商

### AWS Bedrock

**启用方式**：设置环境变量 `CLAUDE_CODE_USE_BEDROCK=1`

**认证**：使用标准 AWS 凭证链
- AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
- AWS 配置文件 (~/.aws/credentials)
- IAM role
- `awsCredentialExport` 设置中的自定义脚本
- `awsAuthRefresh` 设置中的刷新脚本

**STS 验证**：

```typescript
function checkStsCallerIdentity(): Promise<boolean>
// 调用 AWS STS GetCallerIdentity 验证凭证

function isValidAwsStsOutput(output: unknown): boolean
// 验证 STS 响应格式
```

**状态管理**：

```typescript
class AwsAuthStatusManager {
  // 管理 AWS 认证状态（valid/invalid/refreshing）
  // 自动触发凭证刷新
}
```

### Google Cloud Vertex AI

**启用方式**：设置环境变量 `CLAUDE_CODE_USE_VERTEX=1`

**认证**：使用 GCP Application Default Credentials
- `GOOGLE_APPLICATION_CREDENTIALS` 环境变量
- `gcloud auth application-default login`
- GCE Metadata server (在 GCP 环境中)
- `gcpAuthRefresh` 设置中的自定义刷新命令

**配置**：
- `CLOUD_ML_REGION` — Vertex AI 区域
- `ANTHROPIC_VERTEX_PROJECT_ID` — GCP 项目 ID

### Azure Foundry

**启用方式**：设置环境变量 `CLAUDE_CODE_USE_FOUNDRY=1`

**认证**：使用 Azure AD 凭证
- Azure AD Token
- Managed Identity
- Azure CLI 凭证

---

## 核心认证函数

### `isAnthropicAuthEnabled()` (`src/utils/auth.ts`)

判断是否启用 Anthropic 直接认证（非第三方）。

**返回 `false` 的条件：**

1. `--bare` 模式（仅支持 API key）
2. 使用第三方服务（Bedrock/Vertex/Foundry）
3. 用户配置了外部 auth token（`ANTHROPIC_AUTH_TOKEN` 或 `apiKeyHelper`）且非托管 OAuth 上下文
4. 用户有外部 API key（`ANTHROPIC_API_KEY`）且非托管 OAuth 上下文

**特殊情况**：
- `ANTHROPIC_UNIX_SOCKET` 环境变量存在时（SSH remote 模式），仅当 `CLAUDE_CODE_OAUTH_TOKEN` 存在时返回 true

### `getAuthTokenSource()`

检测当前 auth token 的来源：

```typescript
function getAuthTokenSource(): {
  source: 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN' |
          'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' | 'CCR_OAUTH_TOKEN_FILE' |
          'apiKeyHelper' | 'claude.ai' | 'none'
  hasToken: boolean
}
```

**检查顺序：**
1. `ANTHROPIC_AUTH_TOKEN` 环境变量（非托管上下文）
2. `CLAUDE_CODE_OAUTH_TOKEN` 环境变量
3. File descriptor OAuth token
4. `apiKeyHelper`（非托管上下文）
5. Claude.ai OAuth tokens（keychain/config）

### `getAnthropicApiKeyWithSource()`

获取 API key 及其来源：

```typescript
function getAnthropicApiKeyWithSource(
  opts?: { skipRetrievingKeyFromApiKeyHelper?: boolean }
): { key: string | null; source: ApiKeySource }
```

**`--bare` 模式下的行为**：
- 仅检查 `ANTHROPIC_API_KEY` 环境变量和 `apiKeyHelper`
- 不访问 keychain、config 文件或审批列表

### `getSubscriptionType()`

获取用户的订阅类型：

```typescript
function getSubscriptionType(): SubscriptionType
// 返回：'free' | 'pro' | 'max' | 'team_standard' | 'team_premium' | 'enterprise' | 'payg' | ...
```

### 辅助判断函数

```typescript
function isClaudeAISubscriber(): boolean
// 是否为 Claude.ai 付费订阅用户

function isMaxSubscriber(): boolean
// 是否为 Max 订阅用户

function isProSubscriber(): boolean
// 是否为 Pro 订阅用户

function isTeamPremiumSubscriber(): boolean
// 是否为 Team Premium 订阅用户

function isUsing3PServices(): boolean
// 是否使用第三方服务（Bedrock/Vertex/Foundry）
```

---

## 托管 OAuth 上下文

CCR (Claude Code Remote) 和 Claude Desktop 始终使用 OAuth，不应 fallback 到用户本地的 API key 配置：

```typescript
function isManagedOAuthContext(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
  )
}
```

**安全考虑**：在托管上下文中，`settings.json` 中的 `apiKeyHelper`、`env.ANTHROPIC_API_KEY` 和 `env.ANTHROPIC_AUTH_TOKEN` 被忽略，防止终端 CLI 的 API key 配置泄露到 Claude Desktop 会话。

---

## SSH Remote 认证

当通过 `claude ssh` 连接时，认证通过 Unix socket 代理：

- `ANTHROPIC_UNIX_SOCKET` 环境变量指向本地认证代理 socket
- `CLAUDE_CODE_OAUTH_TOKEN` 作为占位符表示本地端是订阅用户
- 远程端不直接持有 token，所有 API 调用通过代理注入认证

---

## 登录/登出流程

### `/login` 命令

1. 启动本地 HTTP server 接收 OAuth 回调
2. 打开浏览器到 `CLAUDE_AI_AUTHORIZE_URL` 或 `CONSOLE_AUTHORIZE_URL`
3. 用户在浏览器中完成授权
4. 回调返回 authorization code
5. 用 code 交换 access token + refresh token
6. 保存 tokens 到 `~/.claude/config.json`

### `/logout` 命令

1. 清除 `~/.claude/config.json` 中的 tokens
2. 可选：从 macOS Keychain 移除 API key
3. 清除所有认证缓存

---

## 认证缓存管理

```typescript
// 各种缓存清除函数
function clearAwsIniCache(): void
function clearBetasCaches(): void
function clearKeychainCache(): void
function clearLegacyApiKeyPrefetch(): void
function clearToolSchemaCache(): void
```

认证状态变化时（如登录/登出、token 刷新、凭证过期），调用相应的缓存清除函数确保一致性。
