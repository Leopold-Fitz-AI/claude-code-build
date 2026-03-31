# Skills 与 Commands 系统

本文档描述 Claude Code 的命令和技能（skill）系统，包括命令类型定义、注册机制、加载流程和 ToolSearch 集成。

---

## Command 类型体系 (`src/types/command.ts`)

### 基础类型 CommandBase

所有命令共享的基础属性：

```typescript
type CommandBase = {
  name: string                           // 命令名称（用于 /name 调用）
  description: string                    // 命令描述
  hasUserSpecifiedDescription?: boolean  // 描述是否来自用户（skill frontmatter）
  aliases?: string[]                     // 别名列表
  availability?: CommandAvailability[]   // 可用性要求（'claude-ai' | 'console'）
  isEnabled?: () => boolean             // 动态启用/禁用检查
  isHidden?: boolean                    // 是否从 typeahead/help 中隐藏
  whenToUse?: string                    // 详细的使用场景描述（用于模型调用决策）
  version?: string                      // 版本号
  disableModelInvocation?: boolean      // 是否禁止模型自动调用
  userInvocable?: boolean               // 用户是否可以通过 /skill-name 调用
  loadedFrom?: LoadedFrom               // 加载来源标识
  kind?: 'workflow'                     // 命令种类（workflow 在自动补全中有特殊标识）
  immediate?: boolean                   // 是否立即执行（跳过命令队列）
  isSensitive?: boolean                 // 是否敏感（参数从历史中脱敏）
  argumentHint?: string                 // 参数提示文本
  isMcp?: boolean                       // 是否来自 MCP server
}
```

### 命令实现类型

Claude Code 支持三种命令实现方式：

#### 1. PromptCommand（提示型命令 / Skill）

最常用的命令类型，将提示内容注入到模型对话中。

```typescript
type PromptCommand = {
  type: 'prompt'
  progressMessage: string           // 执行中的进度消息
  contentLength: number             // 命令内容的字符长度（用于 token 估算）
  argNames?: string[]               // 支持的参数名列表
  allowedTools?: string[]           // 该 skill 允许使用的工具列表
  model?: string                    // 指定使用的模型
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  pluginInfo?: { pluginManifest, repository }  // Plugin 来源信息
  disableNonInteractive?: boolean
  hooks?: HooksSettings             // 技能激活时注册的 hooks
  skillRoot?: string                // 技能资源的基础目录
  context?: 'inline' | 'fork'      // 执行上下文：inline（当前对话）或 fork（子 agent）
  agent?: string                    // fork 模式下的 agent 类型
  effort?: EffortValue              // 思考努力度
  paths?: string[]                  // 适用的文件 glob 模式
  getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]>
}
```

#### 2. LocalCommand（本地命令）

在本地执行逻辑，返回文本结果。

```typescript
type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<{ call: LocalCommandCall }>
}
```

#### 3. LocalJSXCommand（本地 JSX 命令）

在本地执行，返回 React 组件用于 UI 渲染。

```typescript
type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<{ call: LocalJSXCommandCall }>
}
```

### Command 联合类型

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

### CommandAvailability

控制命令在不同认证/提供商环境下的可见性：

- `'claude-ai'` — 仅 Claude.ai OAuth 订阅用户可见
- `'console'` — 仅 Console API key 用户可见

未设置 `availability` 的命令在所有环境下均可用。

---

## 命令来源与注册 (`src/commands.ts`)

### 命令来源层次

Claude Code 从五个来源加载命令，通过 `getCommands()` 统一合并：

```
1. 内建命令 (BUILTIN_COMMANDS)     — 编译到 CLI 中的核心命令
2. Bundled Skills                   — 编译到 CLI 中的技能
3. Built-in Plugin Skills           — 内建 plugin 提供的技能
4. Filesystem Skills                — 从 .claude/ 目录加载的技能
5. Plugin Commands/Skills           — 第三方 plugin 提供的命令和技能
6. MCP Commands                     — MCP 服务器提供的命令
```

### `getCommands()` 函数

主入口函数，从所有来源收集命令并进行去重和过滤：

```typescript
async function getCommands(): Promise<Command[]> {
  // 1. 收集所有来源的命令
  const builtins = BUILTIN_COMMANDS
  const bundledSkills = getBundledSkills()
  const builtinPluginSkills = getBuiltinPluginSkillCommands()
  const skillDirCommands = await getSkillDirCommands()
  const pluginCommands = await getPluginCommands()
  const pluginSkills = await getPluginSkills()
  const dynamicSkills = await getDynamicSkills()

  // 2. 合并，后加入的覆盖先加入的（按 name 去重）
  // 3. 过滤不可用的命令（availability 检查）
  // 4. 过滤被禁用的命令（isEnabled() 检查）
  return commands
}
```

### 内建命令列表（部分）

Claude Code 包含 50+ 内建命令，分为以下类别：

#### Git 操作
| 命令 | 说明 |
|------|------|
| `/commit` | 生成 commit message 并提交 |
| `/diff` | 显示当前更改 diff |
| `/pr-comments` | 查看 PR 评论 |
| `/review` | 代码审查 |

#### 会话管理
| 命令 | 说明 |
|------|------|
| `/session` | 会话管理 |
| `/resume` | 恢复之前的会话 |
| `/compact` | 压缩上下文 |
| `/clear` | 清除对话历史 |
| `/export` | 导出对话记录 |
| `/share` | 分享对话 |
| `/rename` | 重命名会话 |

#### 配置管理
| 命令 | 说明 |
|------|------|
| `/config` | 打开配置界面 |
| `/login` | 登录认证 |
| `/logout` | 登出 |
| `/theme` | 切换主题 |
| `/vim` | 切换 Vim 模式 |
| `/model` | 切换模型 |
| `/permissions` | 权限管理 |
| `/hooks` | Hooks 管理 |

#### 信息查询
| 命令 | 说明 |
|------|------|
| `/help` | 帮助信息 |
| `/status` | 系统状态 |
| `/cost` | 查看费用 |
| `/usage` | 使用量统计 |
| `/doctor` | 系统诊断 |
| `/version` | 版本信息 |

#### 工具管理
| 命令 | 说明 |
|------|------|
| `/skills` | 查看可用技能 |
| `/tasks` | 任务管理 |
| `/mcp` | MCP 服务器管理 |
| `/plugin` | Plugin 管理 |
| `/keybindings` | 快捷键配置 |

#### 高级功能
| 命令 | 说明 |
|------|------|
| `/init` | 初始化项目配置 |
| `/memory` | 记忆管理 |
| `/context` | 上下文管理 |
| `/plan` | 计划模式 |
| `/fast` | 快速模式切换 |
| `/agents` | Agent 管理 |
| `/branch` | 分支管理 |
| `/add-dir` | 添加工作目录 |
| `/ide` | IDE 扩展管理 |
| `/feedback` | 提交反馈 |
| `/color` | 颜色设置 |

#### 条件编译命令

部分命令通过 `bun:bundle` 的 `feature()` 进行条件编译：

```typescript
const proactive = feature('PROACTIVE') ? require('./commands/proactive.js').default : null
const voiceCommand = feature('VOICE_MODE') ? require('./commands/voice/index.js').default : null
const bridge = feature('BRIDGE_MODE') ? require('./commands/bridge/index.js').default : null
```

---

## BundledSkillDefinition (`src/skills/bundledSkills.ts`)

Bundled skills 是编译到 CLI 中的技能定义，对所有用户可用。

### 类型定义

```typescript
type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string                    // 模型调用决策参考
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean               // 默认 true
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'          // 执行上下文
  agent?: string                        // fork 模式下的 agent 类型
  files?: Record<string, string>        // 附带的参考文件（首次调用时提取到磁盘）
  getPromptForCommand: (args: string, context: ToolUseContext) => Promise<ContentBlockParam[]>
}
```

### 注册机制

```typescript
// 内部注册表
const bundledSkills: Command[] = []

// 注册函数
function registerBundledSkill(definition: BundledSkillDefinition): void {
  // 1. 如果有 files，设置 skillRoot 和延迟提取逻辑
  // 2. 构建 Command 对象（type: 'prompt', source: 'bundled', loadedFrom: 'bundled'）
  // 3. 推入 bundledSkills 数组
}

// 获取所有 bundled skills
function getBundledSkills(): Command[] {
  return [...bundledSkills]
}
```

### 文件提取机制

当 bundled skill 定义了 `files` 字段时，首次调用时会将文件提取到磁盘：

```typescript
const skillRoot = getBundledSkillExtractDir(definition.name)
// 提取到 ~/.claude/bundled-skills/<name>/
// 提示内容前缀添加 "Base directory for this skill: <dir>"
```

---

## Skill 文件系统加载 (`src/skills/loadSkillsDir.ts`)

### 加载路径

技能文件从以下目录加载：

| 来源 | 目录 | 说明 |
|------|------|------|
| `policySettings` | `<managed-path>/.claude/skills/` | 企业托管技能 |
| `userSettings` | `~/.claude/skills/` | 用户全局技能 |
| `projectSettings` | `.claude/skills/` | 项目级技能 |
| `plugin` | plugin 目录下的 skills/ | Plugin 提供的技能 |

同时也加载遗留的 `commands/` 目录：

| 来源 | 目录 |
|------|------|
| `policySettings` | `<managed-path>/.claude/commands/` |
| `userSettings` | `~/.claude/commands/` |
| `projectSettings` | `.claude/commands/` |

### 核心函数

#### `getSkillDirCommands()`

从所有 SettingSource 加载 skill 文件：

```typescript
async function getSkillDirCommands(): Promise<Command[]> {
  // 1. 遍历每个 SettingSource（userSettings, projectSettings, policySettings）
  // 2. 加载每个来源的 skills/ 和 commands/ 目录
  // 3. 使用 loadMarkdownFilesForSubdir() 递归发现 .md 文件
  // 4. 解析 frontmatter 和内容
  // 5. 构建 Command 对象
  // 6. 去重处理（同名命令，后加载覆盖先加载）
}
```

#### `getDynamicSkills()`

加载动态技能（基于当前上下文变化的技能）。

#### `clearSkillCaches()`

清除所有技能缓存，用于 hot reload。

---

## Skill Frontmatter 解析 (`src/utils/frontmatterParser.ts`)

Skill 的 `.md` 文件使用 YAML frontmatter 定义元数据。

### FrontmatterData 类型

```typescript
type FrontmatterData = {
  description?: string | null           // 技能描述
  'allowed-tools'?: string | string[] | null  // 允许使用的工具
  'argument-hint'?: string | null       // 参数提示
  when_to_use?: string | null           // 使用场景描述
  version?: string | null               // 版本号
  model?: string | null                 // 模型别名或名称（'haiku', 'sonnet', 'opus', 'inherit'）
  'user-invocable'?: string | null      // 'true' / 'false'
  'hide-from-slash-command-tool'?: string | null  // 是否对 SlashCommand 工具隐藏
  hooks?: HooksSettings | null          // 触发时注册的 hooks
  effort?: string | null                // 思考努力度（'low', 'medium', 'high', 'max'）
  context?: 'inline' | 'fork' | null   // 执行上下文
  agent?: string | null                 // fork 模式下的 agent 类型
  paths?: string | string[] | null      // 文件 glob 模式（条件激活）
  skills?: string | null                // 预加载的技能名称（逗号分隔）
  shell?: string | null                 // Shell 类型（'bash' / 'powershell'）
  type?: string | null                  // 记忆类型（'user', 'feedback', 'project', 'reference'）
}
```

### 解析流程

```
.md 文件 → 分离 frontmatter (--- 分隔符) → YAML 解析 → FrontmatterData 验证 → Command 构建
```

### Frontmatter 示例

```yaml
---
description: 生成代码审查报告
allowed-tools: Read, Grep, Glob
model: sonnet
when_to_use: 当用户需要代码审查时使用
user-invocable: true
context: fork
agent: general-purpose
paths: "**/*.ts,**/*.tsx"
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: echo "Pre-tool hook"
---

# Code Review Skill

请审查以下代码变更...
```

### SettingSource 过滤

技能加载遵循 SettingSource 的启用/禁用状态：

```typescript
function isSettingSourceEnabled(source: SettingSource): boolean
// policySettings 中可以通过 strictPluginOnlyCustomization 锁定 skills/agents/hooks/mcp
```

---

## ToolSearchTool 集成

### Deferred Tools 机制

某些工具被延迟加载（deferred），仅在需要时通过 `ToolSearchTool` 发现和加载。

### 工作流程

1. 系统启动时，deferred tools 仅注册名称，不加载完整 schema
2. 模型可以调用 `ToolSearch` 工具进行关键词搜索
3. `ToolSearch` 返回匹配工具的完整 JSONSchema 定义
4. 匹配的工具变为可调用状态

### 查询格式

```
"select:Read,Edit,Grep"    — 按名称精确选择
"notebook jupyter"          — 关键词搜索
"+slack send"               — 要求名称包含 "slack"，按其余词排序
```

### Skill 与 ToolSearch 的关系

- Skills 的 `whenToUse` 字段被索引，用于 ToolSearch 的语义匹配
- `disableModelInvocation: true` 的技能不会出现在 ToolSearch 结果中
- Bundled skills 和 filesystem skills 都参与 ToolSearch 索引

---

## MCP 命令 (`src/skills/mcpSkillBuilders.ts`)

MCP 服务器可以通过 `registerMCPSkillBuilders()` 提供动态命令。

### 特征

- `isMcp: true` 标记
- `source: 'mcp'`
- `loadedFrom: 'mcp'`
- 命令内容从 MCP 服务器动态获取
- 遵循 MCP 服务器的权限和允许列表配置

---

## 命令执行流程

### 用户输入处理 (`src/utils/processUserInput/processSlashCommand.tsx`)

1. 用户在 PromptInput 中输入 `/command-name args`
2. `processSlashCommand()` 解析命令名称和参数
3. 根据 `command.type` 分发执行：
   - `'prompt'`：调用 `getPromptForCommand(args, context)`，将结果注入对话
   - `'local'`：调用 `command.load()` → `module.call(args, context)`
   - `'local-jsx'`：调用 `command.load()` → `module.call(onDone, context, args)`，渲染返回的 React 节点

### 模型自动调用

模型可以通过 `SkillTool` 自动调用技能：

```typescript
// src/tools/SkillTool/SkillTool.ts
// 模型通过 skill_name 和 args 参数调用
// 仅限 disableModelInvocation !== true 的技能
```

### 命令队列机制

`useCommandQueue()` hook 管理命令的排队执行，确保命令按顺序处理。`immediate: true` 的命令跳过队列立即执行。
