# Settings 与 Configuration 系统

本文档详细描述 Claude Code 的多层设置系统，包括设置来源优先级、MDM 策略支持、schema 验证和全局配置。

---

## 设置来源优先级

Claude Code 使用分层的设置系统，后面的来源覆盖前面的：

```
userSettings < projectSettings < localSettings < flagSettings < policySettings
```

### 各来源详细说明

| 优先级 | 来源标识 | 文件路径 | 说明 |
|--------|----------|----------|------|
| 1 (最低) | `userSettings` | `~/.claude/settings.json` | 用户全局设置 |
| 2 | `projectSettings` | `.claude/settings.json` | 项目共享设置（提交到 git） |
| 3 | `localSettings` | `.claude/settings.local.json` | 项目本地设置（gitignored） |
| 4 | `flagSettings` | `--settings <path>` | CLI flag 指定的设置文件 |
| 5 (最高) | `policySettings` | 托管设置 (managed-settings.json) | 企业策略设置 |

### 来源定义 (`src/utils/settings/constants.ts`)

```typescript
const SETTING_SOURCES = [
  'userSettings',      // 用户全局
  'projectSettings',   // 项目共享
  'localSettings',     // 项目本地
  'flagSettings',      // CLI flag
  'policySettings',    // 企业策略
] as const

type SettingSource = (typeof SETTING_SOURCES)[number]
```

### Cowork 模式

当 `--cowork` 标志或 `CLAUDE_CODE_USE_COWORK_PLUGINS` 环境变量启用时，用户设置文件路径从 `settings.json` 切换为 `cowork_settings.json`。

---

## Policy Settings 优先级

策略设置内部有自己的优先级层次，使用"第一来源获胜"策略：

```
remote managed > macOS plist > Windows HKLM > file-based (managed-settings.json) > Windows HKCU
```

### 各策略来源

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 (最高) | Remote managed | 远程 API 同步的托管设置 |
| 2 | macOS plist | `/Library/Managed Preferences/com.anthropic.claudecode.plist`（MDM 配置） |
| 3 | Windows HKLM | `HKLM\SOFTWARE\Policies\ClaudeCode`（管理员专用） |
| 4 | File-based | `managed-settings.json` + `managed-settings.d/*.json` drop-ins |
| 5 (最低) | Windows HKCU | `HKCU\SOFTWARE\Policies\ClaudeCode`（用户可写） |

---

## MDM 支持 (`src/utils/settings/mdm/`)

### 架构

MDM (Mobile Device Management) 模块分为三层：

| 文件 | 职责 | 依赖 |
|------|------|------|
| `constants.ts` | 共享常量和 plist 路径构建 | 零重依赖 |
| `rawRead.ts` | 子进程 I/O（在 main.tsx 评估时尽早触发） | 零重依赖 |
| `settings.ts` | 解析、缓存、first-source-wins 逻辑 | 解析和验证依赖 |

### macOS 支持

通过 `plutil -convert json -o - <plist-path>` 子进程读取 plist 配置。

**路径**：`/Library/Managed Preferences/com.anthropic.claudecode.plist`

**重要说明**：仅读取 `/Library/Managed Preferences/`（MDM 部署路径），不读取用户可写的 `~/Library/Preferences/`，确保安全性。

### Windows 支持

通过 `reg query` 子进程读取 Windows 注册表：

- **HKLM** (管理员)：`HKLM\SOFTWARE\Policies\ClaudeCode` — 高优先级
- **HKCU** (用户)：`HKCU\SOFTWARE\Policies\ClaudeCode` — 最低优先级

**注册表值名称**：`ManagedSettings`

### 启动并行加载

```typescript
function startMdmSettingsLoad(): void {
  // 在启动期间尽早调用
  // 子进程与模块加载并行运行
  // await mdmLoadPromise 在第一次设置读取前完成
}
```

### Linux

Linux 不使用 MDM，而是通过文件系统路径 `/etc/claude-code/managed-settings.json` 提供托管设置。

---

## Drop-in 配置文件

策略设置支持 systemd 风格的 drop-in 配置：

```
managed-settings.json               ← 基础策略（最低优先级）
managed-settings.d/
  10-otel.json                      ← 按字母顺序排序
  20-security.json                  ← 后面的文件覆盖前面的
  30-team-specific.json
```

**合并规则**：
1. 先加载 `managed-settings.json`
2. 然后按文件名字母顺序加载 `managed-settings.d/*.json`
3. 使用 `mergeWith` 深度合并，数组字段替换而非追加

---

## SettingsJson Schema (`src/utils/settings/types.ts`)

### 核心 Schema 定义

```typescript
const SettingsSchema = z.object({
  $schema: z.literal(CLAUDE_CODE_SETTINGS_SCHEMA_URL).optional(),

  // 认证
  apiKeyHelper: z.string().optional(),          // 输出认证值的脚本路径
  awsCredentialExport: z.string().optional(),   // AWS 凭证导出脚本
  awsAuthRefresh: z.string().optional(),        // AWS 认证刷新脚本
  gcpAuthRefresh: z.string().optional(),        // GCP 认证刷新命令

  // 模型
  model: z.string().optional(),                 // 默认模型名称或别名

  // 权限
  permissions: PermissionsSchema.optional(),

  // 沙箱
  sandbox: SandboxSettingsSchema.optional(),

  // Hooks
  hooks: HooksSchema.optional(),

  // 环境变量
  env: EnvironmentVariablesSchema.optional(),

  // Plugin
  enabledPlugins: z.record(z.boolean()).optional(),

  // MCP 服务器
  mcpServers: z.record(McpServerConfig).optional(),
  allowedMcpServers: z.array(AllowedMcpServerEntrySchema).optional(),
  deniedMcpServers: z.array(DeniedMcpServerEntrySchema).optional(),

  // Auto 模式
  autoMode: z.boolean().optional(),

  // 行为配置
  respectGitignore: z.boolean().optional(),
  fileSuggestion: z.object({...}).optional(),

  // 企业功能
  availableModels: z.array(z.string()).optional(),  // 模型允许列表
  strictPluginOnlyCustomization: z.array(z.enum([...])).optional(),

  // ... 更多字段
}).passthrough()  // 保留未知字段，向后兼容
```

### PermissionsSchema

```typescript
const PermissionsSchema = z.object({
  allow: z.array(PermissionRuleSchema).optional(),    // 允许规则列表
  deny: z.array(PermissionRuleSchema).optional(),     // 拒绝规则列表
  ask: z.array(PermissionRuleSchema).optional(),      // 始终询问的规则
  defaultMode: z.enum(PERMISSION_MODES).optional(),   // 默认权限模式
  disableBypassPermissionsMode: z.enum(['disable']).optional(),
  additionalDirectories: z.array(z.string()).optional(),  // 额外允许的目录
}).passthrough()
```

### 向后兼容性规则

Schema 设计遵循严格的向后兼容性：

**允许的更改：**
- 添加新的 optional 字段
- 添加新的 enum 值（保留已有值）
- 使验证更宽松
- 使用 union 类型进行渐进迁移

**禁止的更改：**
- 删除字段（应标记为 deprecated）
- 删除 enum 值
- 将 optional 变为 required
- 使类型更严格
- 重命名字段（除非保留旧名称）

---

## 设置缓存系统 (`src/utils/settings/settingsCache.ts`)

### 缓存层次

1. **文件级缓存** (`getCachedParsedFile` / `setCachedParsedFile`)
   - 按文件路径缓存解析结果
   - 返回 clone 副本防止调用者修改缓存

2. **来源级缓存** (`getCachedSettingsForSource` / `setCachedSettingsForSource`)
   - 按 SettingSource 缓存合并后的设置

3. **会话级缓存** (`getSessionSettingsCache` / `setSessionSettingsCache`)
   - 缓存所有来源合并后的最终设置

### 缓存失效

```typescript
function resetSettingsCache(): void {
  // 清除所有层级的缓存
  // 在设置文件变更时调用
}
```

### Plugin 设置缓存

```typescript
function getPluginSettingsBase(): SettingsJson | null
// Plugin 提供的基础设置，参与合并
```

---

## 验证系统 (`src/utils/settings/validation.ts`)

### Zod Schema 验证

```typescript
function parseSettingsFile(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
}
```

验证流程：
1. 读取文件内容（支持 symlink 解析）
2. JSON 解析
3. `filterInvalidPermissionRules()` — 预先过滤无效的权限规则（一个坏规则不会导致整个文件被拒绝）
4. `SettingsSchema().safeParse(data)` — Zod schema 验证
5. 成功时返回验证后的数据；失败时返回格式化的错误列表

### ValidationError 类型

```typescript
type ValidationError = {
  path: string        // 设置文件路径
  message: string     // 错误描述
}
```

### 无效权限规则过滤

```typescript
function filterInvalidPermissionRules(data: unknown, path: string): ValidationError[]
// 单独验证权限规则，无效规则被过滤而非拒绝整个文件
// 返回过滤掉的规则的警告信息
```

---

## 核心函数

### `getInitialSettings()`

启动时加载初始设置，合并所有来源：

```typescript
function getInitialSettings(): SettingsJson {
  // 1. 加载每个 SettingSource 的设置
  // 2. 按优先级合并
  // 3. 缓存结果
  // 4. 返回最终合并的设置
}
```

### `getSettingsWithErrors()`

获取设置及其验证错误：

```typescript
function getSettingsWithErrors(): SettingsWithErrors {
  // 返回 { settings, errors } 对
  // errors 包含所有来源的验证错误
}
```

### `updateSettingsForSource()`

更新指定来源的设置：

```typescript
function updateSettingsForSource(
  source: EditableSettingSource,
  updater: (current: SettingsJson) => SettingsJson
): void {
  // 1. 读取当前文件
  // 2. 应用更新
  // 3. 保留未知字段（向后兼容）
  // 4. 写入文件
  // 5. 清除缓存
}
```

### `getSettingsForSource()`

获取单个来源的设置：

```typescript
function getSettingsForSource(source: SettingSource): SettingsJson | null
```

### `getSettings_DEPRECATED()`

获取合并后的最终设置（遗留接口，推荐使用更精细的 API）：

```typescript
function getSettings_DEPRECATED(): SettingsJson | null
```

---

## 设置变更检测 (`src/utils/settings/changeDetector.ts`)

监听设置文件变更并触发回调：

```typescript
// 文件系统监听
// 检测外部编辑（如用户直接编辑 settings.json）
// 触发缓存失效和 UI 更新
```

---

## Global Config (`src/utils/config.ts`)

全局配置存储在 `~/.claude/config.json`，用于非设置类的运行时状态。

### 配置内容

```typescript
type GlobalConfig = {
  // 发布频道
  releaseChannel?: ReleaseChannel       // 'stable' | 'latest'

  // Changelog 缓存
  changelogLastSeen?: string            // 上次查看的版本

  // 信任状态
  trustDialogAccepted?: boolean         // 是否已接受信任对话

  // 认证
  auth?: {
    oauthTokens?: OAuthTokens           // OAuth token 缓存
    accountInfo?: AccountInfo           // 账户信息
  }

  // 历史记录
  history?: HistoryEntry[]              // 输入历史

  // 项目配置
  projects?: Record<string, ProjectConfig>  // 按项目路径索引

  // UI 状态
  theme?: ThemeSetting                  // 主题设置

  // 更新信息
  lastUpdateCheck?: string              // 上次检查更新时间

  // ... 更多运行时状态字段
}
```

### 核心操作

```typescript
function getGlobalConfig(): GlobalConfig
// 读取并解析 ~/.claude/config.json
// 带有重入锁防止循环依赖

function saveGlobalConfig(config: GlobalConfig): void
// 原子写入 config.json
// 使用文件锁防止并发写入

function getProjectConfig(cwd?: string): ProjectConfig | undefined
// 获取指定项目目录的配置
```

---

## 设置路径解析

### 各来源的文件路径

```typescript
function getSettingsFilePathForSource(source: SettingSource): string | undefined {
  switch (source) {
    case 'userSettings':     return '~/.claude/settings.json'
    case 'projectSettings':  return '<cwd>/.claude/settings.json'
    case 'localSettings':    return '<cwd>/.claude/settings.local.json'
    case 'flagSettings':     return '<flag-path>'
    case 'policySettings':   return '<managed-path>/managed-settings.json'
  }
}
```

### 根路径

```typescript
function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':    return resolve(getClaudeConfigHomeDir())  // ~/.claude
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':   return resolve(getOriginalCwd())
    case 'flagSettings':    return dirname(resolve(flagPath)) || resolve(cwd)
  }
}
```

---

## 设置合并策略

### `settingsMergeCustomizer`

合并多个来源的设置时使用的自定义合并器：

- **数组字段**：后来源的数组替换前来源（非追加）
- **对象字段**：深度合并
- **标量字段**：后来源覆盖前来源

### 合并顺序

```
userSettings → merge(projectSettings) → merge(localSettings) → merge(flagSettings) → merge(policySettings)
```

最终结果中，高优先级来源的值覆盖低优先级来源。

---

## 企业功能

### 模型允许列表 (`availableModels`)

```json
{
  "availableModels": ["sonnet", "opus", "claude-sonnet-4-20250514"]
}
```

- 支持 family alias（如 `"opus"` 允许所有 Opus 版本）
- 支持精确模型 ID
- 在 policySettings 中设置时，限制用户可选择的模型

### Strict Plugin Only Customization

```json
{
  "strictPluginOnlyCustomization": ["skills", "agents", "hooks", "mcp"]
}
```

锁定指定表面（surface），仅允许通过 plugin 进行自定义。

### MCP 服务器允许/拒绝列表

```json
{
  "allowedMcpServers": [
    { "serverName": "my-server" },
    { "serverCommand": ["npx", "my-tool"] },
    { "serverUrl": "https://*.example.com/*" }
  ],
  "deniedMcpServers": [
    { "serverName": "blocked-server" }
  ]
}
```

每个条目必须恰好指定 `serverName`、`serverCommand` 或 `serverUrl` 中的一个。
