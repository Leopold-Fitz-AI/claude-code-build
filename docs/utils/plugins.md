# Plugin 系统

本文档描述 Claude Code 的插件系统，涵盖插件类型定义、内建插件注册、加载生命周期、发现机制和设置持久化。

---

## Plugin 架构概览

Claude Code 的 plugin 系统支持通过插件扩展 CLI 的能力。插件可以提供以下组件：

```
Plugin
├── Skills (技能/命令)     — 注入对话的提示型命令
├── Agents (Agent 定义)    — 自定义 agent 配置
├── Hooks (钩子)           — PreToolUse/PostToolUse/Stop 等生命周期钩子
├── Output Styles (输出样式) — 自定义输出格式
├── MCP Servers             — Model Context Protocol 服务器
└── LSP Servers             — Language Server Protocol 服务器
```

---

## Plugin 类型定义

### BuiltinPluginDefinition (`src/types/plugin.ts`)

内建插件的定义类型，用于编译到 CLI 中的插件：

```typescript
type BuiltinPluginDefinition = {
  /** Plugin 名称（用于 `{name}@builtin` 标识符） */
  name: string

  /** /plugin UI 中显示的描述 */
  description: string

  /** 可选版本号 */
  version?: string

  /** 提供的技能列表 */
  skills?: BundledSkillDefinition[]

  /** 提供的 hooks 配置 */
  hooks?: HooksSettings

  /** 提供的 MCP 服务器 */
  mcpServers?: Record<string, McpServerConfig>

  /** 可用性检查（基于系统能力）。不可用的插件完全隐藏 */
  isAvailable?: () => boolean

  /** 用户设置偏好前的默认启用状态（默认 true） */
  defaultEnabled?: boolean
}
```

### LoadedPlugin (`src/types/plugin.ts`)

已加载插件的运行时表示：

```typescript
type LoadedPlugin = {
  /** Plugin 名称 */
  name: string

  /** Plugin manifest（名称、描述、版本） */
  manifest: PluginManifest

  /** 文件系统路径（内建插件为 'builtin' 哨兵值） */
  path: string

  /** 来源标识符（如 'my-plugin@marketplace-name'） */
  source: string

  /** Repository 标识符，通常与 source 相同 */
  repository: string

  /** 是否启用 */
  enabled?: boolean

  /** 是否为内建插件 */
  isBuiltin?: boolean

  /** Git commit SHA，用于版本锁定 */
  sha?: string

  /** 命令路径 */
  commandsPath?: string
  commandsPaths?: string[]          // 额外的命令路径
  commandsMetadata?: Record<string, CommandMetadata>  // 命令元数据

  /** Agent 路径 */
  agentsPath?: string
  agentsPaths?: string[]

  /** 技能路径 */
  skillsPath?: string
  skillsPaths?: string[]

  /** 输出样式路径 */
  outputStylesPath?: string
  outputStylesPaths?: string[]

  /** Hooks 配置 */
  hooksConfig?: HooksSettings

  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerConfig>

  /** LSP 服务器配置 */
  lspServers?: Record<string, LspServerConfig>

  /** Plugin 级别的设置 */
  settings?: Record<string, unknown>
}
```

### PluginManifest

```typescript
type PluginManifest = {
  name: string
  description: string
  version?: string
  author?: PluginAuthor
  // ... 其他 manifest 字段
}
```

### PluginComponent 类型

```typescript
type PluginComponent =
  | 'commands'       // 命令（遗留，逐步迁移到 skills）
  | 'agents'         // Agent 定义
  | 'skills'         // 技能
  | 'hooks'          // 钩子
  | 'output-styles'  // 输出样式
```

---

## Plugin 生命周期

### 1. 注册 (Registration)

#### 内建插件注册

```typescript
// src/plugins/builtinPlugins.ts
function registerBuiltinPlugin(definition: BuiltinPluginDefinition): void {
  // 将 definition 存入内部 Map<string, BuiltinPluginDefinition>
  BUILTIN_PLUGINS.set(definition.name, definition)
}
```

内建插件在 `initBuiltinPlugins()` 中注册，该函数在启动时调用。

#### 第三方插件注册

通过 marketplace 发现和安装的插件，通过 `pluginLoader.ts` 加载。

### 2. 加载 (Loading)

#### 内建插件加载

```typescript
function getBuiltinPlugins(): { enabled: LoadedPlugin[]; disabled: LoadedPlugin[] } {
  const settings = getSettings_DEPRECATED()

  for (const [name, definition] of BUILTIN_PLUGINS) {
    // 1. 检查 isAvailable() — 不可用则跳过
    if (definition.isAvailable && !definition.isAvailable()) continue

    // 2. 确定启用状态：用户设置 > 插件默认 > true
    const pluginId = `${name}@builtin`
    const userSetting = settings?.enabledPlugins?.[pluginId]
    const isEnabled = userSetting !== undefined
      ? userSetting === true
      : (definition.defaultEnabled ?? true)

    // 3. 构建 LoadedPlugin 对象
    const plugin: LoadedPlugin = {
      name,
      manifest: { name, description: definition.description, version: definition.version },
      path: 'builtin',    // 哨兵值，表示无文件系统路径
      source: pluginId,
      repository: pluginId,
      enabled: isEnabled,
      isBuiltin: true,
      hooksConfig: definition.hooks,
      mcpServers: definition.mcpServers,
    }

    // 4. 分入 enabled 或 disabled 列表
    if (isEnabled) enabled.push(plugin)
    else disabled.push(plugin)
  }

  return { enabled, disabled }
}
```

#### 技能命令提取

```typescript
function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  const commands: Command[] = []

  for (const plugin of enabled) {
    const definition = BUILTIN_PLUGINS.get(plugin.name)
    if (!definition?.skills) continue

    for (const skill of definition.skills) {
      commands.push(skillDefinitionToCommand(skill))
    }
  }

  return commands
}
```

### 3. 启用/禁用 (Enable/Disable)

用户通过 `/plugin` 命令界面切换插件状态。状态变更持久化到 `settings.json` 的 `enabledPlugins` 字段。

### 4. 清理 (Cleanup)

卸载插件时：
- 停止该插件注册的 MCP 服务器
- 移除该插件注册的 hooks
- 清除技能缓存
- 如果是第三方插件，可选清除本地文件

---

## Plugin 发现

### 内建插件发现

内建插件在编译时确定，通过 `registerBuiltinPlugin()` 硬编码注册。

**识别标志**：Plugin ID 以 `@builtin` 结尾。

```typescript
function isBuiltinPluginId(pluginId: string): boolean {
  return pluginId.endsWith('@builtin')
}
```

### 文件系统扫描

第三方插件从以下位置扫描：
- 用户配置的 plugin 目录
- Marketplace 安装目录

Plugin manifest (`plugin.json` 或 `package.json`) 定义了插件的能力声明。

### Marketplace

Marketplace 提供集中的插件发现和安装：

```typescript
// 在 settings.json 中配置额外的 marketplace
const ExtraKnownMarketplaceSchema = z.object({
  source: MarketplaceSourceSchema,     // marketplace 来源
  installLocation: z.string().optional(), // 本地缓存路径
  autoUpdate: z.boolean().optional(),     // 是否自动更新
})
```

---

## Plugin 设置持久化

### enabledPlugins 配置

在 `settings.json` 中，`enabledPlugins` 字段记录每个插件的启用状态：

```json
{
  "enabledPlugins": {
    "my-plugin@builtin": true,
    "another-plugin@marketplace": false,
    "third-plugin@custom-marketplace": true
  }
}
```

### Plugin ID 格式

```
{plugin-name}@{marketplace-name}
```

| 示例 | 说明 |
|------|------|
| `code-review@builtin` | 内建的代码审查插件 |
| `linter@my-marketplace` | 来自 my-marketplace 的 linter 插件 |

### 启用状态解析优先级

```
1. settings.enabledPlugins[pluginId] 显式设置   — 最高优先级
2. BuiltinPluginDefinition.defaultEnabled        — 内建插件默认值
3. true                                          — 全局默认（启用）
```

---

## Plugin 命令加载 (`src/utils/plugins/loadPluginCommands.ts`)

### 命令加载

```typescript
async function getPluginCommands(): Promise<Command[]>
// 从已启用的第三方插件加载命令（commands/ 目录）

async function getPluginSkills(): Promise<Command[]>
// 从已启用的第三方插件加载技能（skills/ 目录）
```

### 缓存管理

```typescript
function clearPluginCommandCache(): void
// 清除插件命令缓存

function clearPluginSkillsCache(): void
// 清除插件技能缓存
```

---

## Plugin 错误处理 (`src/types/plugin.ts`)

### 错误类型系统

Plugin 使用类型安全的错误系统：

```typescript
// 已实现的错误类型：
type PluginError =
  | { type: 'generic-error'; message: string }
  | { type: 'plugin-not-found'; pluginName: string; marketplace: string }

// 计划中的错误类型（渐进实现）：
// | { type: 'path-not-found' }
// | { type: 'git-auth-failed' }
// | { type: 'git-timeout' }
// | { type: 'network-error' }
// | { type: 'manifest-parse-error' }
// | { type: 'manifest-validation-error' }
// | { type: 'marketplace-not-found' }
// | { type: 'marketplace-load-failed' }
// | { type: 'mcp-config-invalid' }
// | { type: 'hook-load-failed' }
// | { type: 'component-load-failed' }
```

---

## Plugin 与其他系统的集成

### Skills 集成

Plugin 中的 skills 使用与 bundled skills 相同的 `BundledSkillDefinition` 类型：

```typescript
skills?: BundledSkillDefinition[]
```

每个 skill 通过 `skillDefinitionToCommand()` 转换为 `Command` 对象，参与到统一的命令系统中。

### Hooks 集成

Plugin 的 hooks 使用标准的 `HooksSettings` 格式：

```typescript
hooks?: HooksSettings
// HooksSettings 定义了 PreToolUse, PostToolUse, Stop 等钩子事件的处理器
```

当 plugin 启用时，其 hooks 被注册到全局 hook 系统中；禁用时被移除。

### MCP Servers 集成

Plugin 可以提供 MCP 服务器：

```typescript
mcpServers?: Record<string, McpServerConfig>
```

启用的 plugin 的 MCP 服务器会自动连接和管理。

### LSP Servers 集成

Plugin 可以提供 LSP 服务器配置：

```typescript
lspServers?: Record<string, LspServerConfig>
```

用于代码智能功能（如自动补全、诊断等）。

---

## 核心函数汇总

| 函数 | 文件 | 说明 |
|------|------|------|
| `registerBuiltinPlugin(def)` | `builtinPlugins.ts` | 注册内建插件 |
| `getBuiltinPlugins()` | `builtinPlugins.ts` | 获取所有内建插件（分启用/禁用） |
| `getBuiltinPluginSkillCommands()` | `builtinPlugins.ts` | 获取启用的内建插件的技能命令 |
| `getBuiltinPluginDefinition(name)` | `builtinPlugins.ts` | 按名称获取内建插件定义 |
| `isBuiltinPluginId(id)` | `builtinPlugins.ts` | 判断是否为内建插件 ID |
| `getPluginCommands()` | `loadPluginCommands.ts` | 获取第三方插件命令 |
| `getPluginSkills()` | `loadPluginCommands.ts` | 获取第三方插件技能 |
| `clearPluginCommandCache()` | `loadPluginCommands.ts` | 清除命令缓存 |
| `clearPluginSkillsCache()` | `loadPluginCommands.ts` | 清除技能缓存 |

---

## Plugin 安全性

### 信任模型

1. **内建插件**：编译到 CLI 中，完全受信
2. **Marketplace 插件**：经过 marketplace 审核，需用户显式安装
3. **自定义插件**：需用户手动配置，自行承担风险

### 权限约束

Plugin 受到以下约束：

- **strictPluginOnlyCustomization**：企业策略可以限制仅允许通过 plugin 进行 skills/agents/hooks/mcp 自定义
- **MCP 服务器允许列表**：plugin 提供的 MCP 服务器受 `allowedMcpServers` / `deniedMcpServers` 约束
- **沙箱**：plugin 触发的工具调用受到常规沙箱和权限规则的限制

### Startup Checks

```typescript
// src/utils/plugins/performStartupChecks.tsx
// 启动时对已安装的插件执行安全和完整性检查
```

---

## /plugin 命令 UI

`/plugin` 命令提供交互式界面：

1. **Browse** — 浏览可用插件（内建 + marketplace）
2. **Enable/Disable** — 切换插件启用状态
3. **Install** — 从 marketplace 安装新插件
4. **Update** — 更新已安装的插件
5. **Remove** — 卸载第三方插件
6. **Info** — 查看插件详情（技能、hooks、MCP servers 列表）

内建插件在 UI 中标注为 "Built-in" 区段，与第三方插件视觉区分。
