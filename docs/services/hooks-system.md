# Hooks 事件系统

> Claude Code 的 Hooks 系统允许在工具执行、会话生命周期和权限决策等关键节点注入自定义逻辑。
> 源码路径: `src/utils/hooks.ts`, `src/types/hooks.ts`, `src/schemas/hooks.ts`

---

## 目录

- [总体架构](#总体架构)
- [Hook 事件类型 (28 种)](#hook-事件类型-28-种)
- [Hook 输入 (HookInput)](#hook-输入-hookinput)
- [Hook 输出 (HookJSONOutput)](#hook-输出-hookjsonoutput)
- [Hook 命令类型 (HookCommand)](#hook-命令类型-hookcommand)
- [Hook 来源](#hook-来源)
- [配置格式](#配置格式)
- [权限系统集成](#权限系统集成)
- [Hook 生命周期](#hook-生命周期)
- [类型定义详解](#类型定义详解)

---

## 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Code 运行时                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Hook 事件触发点                              │   │
│  │                                                          │   │
│  │  SessionStart → PreToolUse → PostToolUse → Stop          │   │
│  │       │            │              │           │          │   │
│  │  SubagentStart  PermissionRequest  Notification          │   │
│  │       │            │                    │                │   │
│  │  UserPromptSubmit  Elicitation   FileChanged             │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Hook 分发器 (hooks.ts)                       │   │
│  │                                                          │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │   │
│  │  │ 配置匹配 │  │ 条件过滤 │  │ 超时管理              │   │   │
│  │  │ (matcher) │  │ (if)     │  │ (timeout)            │   │   │
│  │  └──────────┘  └──────────┘  └──────────────────────┘   │   │
│  └────────────────────────┬─────────────────────────────────┘   │
│                           │                                     │
│            ┌──────────────┼──────────────────┐                  │
│            ▼              ▼                  ▼                  │
│     ┌────────────┐ ┌───────────┐   ┌──────────────┐            │
│     │ Shell 命令 │ │ SDK 回调  │   │ Plugin hooks │            │
│     │ (command)  │ │ (callback)│   │              │            │
│     └────────────┘ └───────────┘   └──────────────┘            │
│            │              │                  │                  │
│            └──────────────┼──────────────────┘                  │
│                           ▼                                     │
│     ┌────────────────────────────────────────────────────────┐  │
│     │              HookResult / AggregatedHookResult         │  │
│     │  continue | suppressOutput | decision | permission     │  │
│     └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Hook 事件类型 (28 种)

定义位于 `src/entrypoints/sdk/coreSchemas.ts`:

```typescript
export const HOOK_EVENTS = [
  'PreToolUse',          // 工具执行前
  'PostToolUse',         // 工具执行后 (成功)
  'PostToolUseFailure',  // 工具执行后 (失败)
  'Notification',        // 通知事件
  'UserPromptSubmit',    // 用户提交 prompt
  'SessionStart',        // 会话开始
  'SessionEnd',          // 会话结束
  'Stop',                // 停止事件
  'StopFailure',         // 停止失败
  'SubagentStart',       // 子 agent 启动
  'SubagentStop',        // 子 agent 停止
  'PreCompact',          // 压缩前
  'PostCompact',         // 压缩后
  'PermissionRequest',   // 权限请求
  'PermissionDenied',    // 权限拒绝
  'Setup',               // 初始设置
  'TeammateIdle',        // Teammate 空闲
  'TaskCreated',         // 任务创建
  'TaskCompleted',       // 任务完成
  'Elicitation',         // Elicitation 请求
  'ElicitationResult',   // Elicitation 结果
  'ConfigChange',        // 配置变更
  'WorktreeCreate',      // Worktree 创建
  'WorktreeRemove',      // Worktree 移除
  'InstructionsLoaded',  // 指令加载完成
  'CwdChanged',          // 工作目录变更
  'FileChanged',         // 文件变更
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]
```

### 事件分类

| 类别 | 事件 | 说明 |
|------|------|------|
| **工具生命周期** | PreToolUse, PostToolUse, PostToolUseFailure | 工具调用前后触发 |
| **会话生命周期** | SessionStart, SessionEnd, Setup | 会话和初始化 |
| **Agent 生命周期** | SubagentStart, SubagentStop | 子 agent 管理 |
| **权限系统** | PermissionRequest, PermissionDenied | 权限决策点 |
| **用户交互** | UserPromptSubmit, Notification, Elicitation, ElicitationResult | 用户输入和反馈 |
| **停止控制** | Stop, StopFailure | 停止信号处理 |
| **压缩** | PreCompact, PostCompact | Context 压缩前后 |
| **任务管理** | TaskCreated, TaskCompleted, TeammateIdle | 任务和协作 |
| **配置与环境** | ConfigChange, CwdChanged, FileChanged, InstructionsLoaded | 环境变化 |
| **Worktree** | WorktreeCreate, WorktreeRemove | Git worktree 操作 |

---

## Hook 输入 (HookInput)

### 基础输入字段

所有 hook 事件都包含以下基础字段:

```typescript
// BaseHookInput (来自 coreSchemas.ts)
{
  session_id: string,              // 会话 ID
  transcript_path: string,         // Transcript 文件路径
  cwd: string,                     // 当前工作目录
  permission_mode?: string,        // 权限模式
  agent_id?: string,               // Agent ID
  agent_type?: string,             // Agent 类型
}
```

### 事件特定输入

#### PreToolUse

```typescript
type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PreToolUse'
  tool_name: string           // 工具名称 (如 "Bash", "Write")
  tool_input: Record<string, unknown>  // 工具输入参数
}
```

#### PostToolUse

```typescript
type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_output?: string        // 工具输出 (可能被截断)
}
```

#### PostToolUseFailure

```typescript
type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: Record<string, unknown>
  error?: string              // 错误信息
}
```

#### SessionStart

```typescript
type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart'
}
```

#### SessionEnd

```typescript
type SessionEndHookInput = BaseHookInput & {
  hook_event_name: 'SessionEnd'
}
```

#### PermissionRequest

```typescript
type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: Record<string, unknown>
}
```

#### PermissionDenied

```typescript
type PermissionDeniedHookInput = BaseHookInput & {
  hook_event_name: 'PermissionDenied'
  tool_name: string
  tool_input: Record<string, unknown>
}
```

#### Notification

```typescript
type NotificationHookInput = BaseHookInput & {
  hook_event_name: 'Notification'
  message: string
}
```

#### UserPromptSubmit

```typescript
type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: 'UserPromptSubmit'
  user_prompt: string
}
```

#### Stop / StopFailure

```typescript
type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop'
  stop_reason?: string
}

type StopFailureHookInput = BaseHookInput & {
  hook_event_name: 'StopFailure'
  error?: string
}
```

#### SubagentStart / SubagentStop

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart'
}

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop'
}
```

#### PreCompact / PostCompact

```typescript
type PreCompactHookInput = BaseHookInput & {
  hook_event_name: 'PreCompact'
}

type PostCompactHookInput = BaseHookInput & {
  hook_event_name: 'PostCompact'
}
```

#### TaskCreated / TaskCompleted

```typescript
type TaskCreatedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCreated'
}

type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCompleted'
}
```

#### CwdChanged / FileChanged / InstructionsLoaded

```typescript
type CwdChangedHookInput = BaseHookInput & {
  hook_event_name: 'CwdChanged'
  new_cwd: string
}

type FileChangedHookInput = BaseHookInput & {
  hook_event_name: 'FileChanged'
  file_path: string
}

type InstructionsLoadedHookInput = BaseHookInput & {
  hook_event_name: 'InstructionsLoaded'
}
```

#### Elicitation / ElicitationResult / ConfigChange

```typescript
type ElicitationHookInput = BaseHookInput & {
  hook_event_name: 'Elicitation'
}

type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: 'ElicitationResult'
}

type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: 'ConfigChange'
}
```

---

## Hook 输出 (HookJSONOutput)

### 同步输出 (SyncHookJSONOutput)

```typescript
export const syncHookResponseSchema = z.object({
  // 是否继续执行 (默认: true)
  continue: z.boolean().optional(),

  // 是否隐藏 stdout (默认: false)
  suppressOutput: z.boolean().optional(),

  // continue=false 时显示的停止原因
  stopReason: z.string().optional(),

  // 权限决策: approve 或 block
  decision: z.enum(['approve', 'block']).optional(),

  // 决策原因说明
  reason: z.string().optional(),

  // 显示给用户的警告消息
  systemMessage: z.string().optional(),

  // 事件特定输出 (按 hookEventName 区分)
  hookSpecificOutput: z.union([
    // PreToolUse 特定
    z.object({
      hookEventName: z.literal('PreToolUse'),
      permissionDecision: permissionBehaviorSchema().optional(),
      permissionDecisionReason: z.string().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      additionalContext: z.string().optional(),
    }),
    // UserPromptSubmit 特定
    z.object({
      hookEventName: z.literal('UserPromptSubmit'),
      additionalContext: z.string().optional(),
    }),
    // SessionStart 特定
    z.object({
      hookEventName: z.literal('SessionStart'),
      additionalContext: z.string().optional(),
      initialUserMessage: z.string().optional(),
      watchPaths: z.array(z.string()).optional(),  // FileChanged 监视路径
    }),
    // Setup 特定
    z.object({
      hookEventName: z.literal('Setup'),
      additionalContext: z.string().optional(),
    }),
    // SubagentStart 特定
    z.object({
      hookEventName: z.literal('SubagentStart'),
      additionalContext: z.string().optional(),
    }),
    // PostToolUse 特定
    z.object({
      hookEventName: z.literal('PostToolUse'),
      additionalContext: z.string().optional(),
      updatedMCPToolOutput: z.unknown().optional(),  // 更新 MCP 工具输出
    }),
    // PostToolUseFailure 特定
    z.object({
      hookEventName: z.literal('PostToolUseFailure'),
      additionalContext: z.string().optional(),
    }),
    // PermissionDenied 特定
    z.object({
      hookEventName: z.literal('PermissionDenied'),
      retry: z.boolean().optional(),
    }),
    // Notification 特定
    z.object({
      hookEventName: z.literal('Notification'),
      additionalContext: z.string().optional(),
    }),
    // PermissionRequest 特定
    z.object({
      hookEventName: z.literal('PermissionRequest'),
      decision: z.union([
        z.object({
          behavior: z.literal('allow'),
          updatedInput: z.record(z.string(), z.unknown()).optional(),
          updatedPermissions: z.array(permissionUpdateSchema()).optional(),
        }),
        z.object({
          behavior: z.literal('deny'),
          message: z.string().optional(),
          interrupt: z.boolean().optional(),
        }),
      ]),
    }),
    // Elicitation 特定
    z.object({
      hookEventName: z.literal('Elicitation'),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
    // ElicitationResult 特定
    z.object({
      hookEventName: z.literal('ElicitationResult'),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
    // CwdChanged 特定
    z.object({
      hookEventName: z.literal('CwdChanged'),
      watchPaths: z.array(z.string()).optional(),
    }),
    // FileChanged 特定
    z.object({
      hookEventName: z.literal('FileChanged'),
      watchPaths: z.array(z.string()).optional(),
    }),
    // WorktreeCreate 特定
    z.object({
      hookEventName: z.literal('WorktreeCreate'),
      worktreePath: z.string(),
    }),
  ]).optional(),
})
```

### 异步输出 (AsyncHookJSONOutput)

```typescript
const asyncHookResponseSchema = z.object({
  async: z.literal(true),
  asyncTimeout: z.number().optional(),
})
```

### 完整输出类型

```typescript
export const hookJSONOutputSchema = z.union([
  asyncHookResponseSchema,
  syncHookResponseSchema(),
])

type HookJSONOutput = z.infer<typeof hookJSONOutputSchema>
```

### 类型守卫

```typescript
export function isSyncHookJSONOutput(json: HookJSONOutput): json is SyncHookJSONOutput
export function isAsyncHookJSONOutput(json: HookJSONOutput): json is AsyncHookJSONOutput
```

---

## Hook 命令类型 (HookCommand)

定义位于 `src/schemas/hooks.ts`:

### Shell 命令 Hook (command)

```typescript
const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),           // 要执行的 Shell 命令
  if: z.string().optional(),     // 条件过滤 (权限规则语法)
  shell: z.enum(SHELL_TYPES).optional(),  // 'bash' | 'powershell'
  timeout: z.number().positive().optional(),  // 超时 (秒)
  statusMessage: z.string().optional(),  // Spinner 显示消息
  once: z.boolean().optional(),   // 只执行一次
  async: z.boolean().optional(),  // 后台执行
  asyncRewake: z.boolean().optional(),  // 后台执行，exit code 2 时唤醒
})
```

### Prompt Hook (prompt)

```typescript
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string(),            // LLM prompt (支持 $ARGUMENTS 占位符)
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  model: z.string().optional(),  // 使用的模型 (默认: small fast model)
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### HTTP Hook (http)

```typescript
const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),         // POST 目标 URL
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),  // 自定义 headers
  allowedEnvVars: z.array(z.string()).optional(),  // 允许在 headers 中插值的环境变量
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### Agent Hook (agent)

```typescript
const AgentHookSchema = z.object({
  type: z.literal('agent'),
  prompt: z.string(),            // 验证 prompt (支持 $ARGUMENTS)
  if: z.string().optional(),
  timeout: z.number().positive().optional(),  // 默认 60 秒
  model: z.string().optional(),  // 默认使用 Haiku
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### 联合类型

```typescript
export const HookCommandSchema = z.discriminatedUnion('type', [
  BashCommandHookSchema,
  PromptHookSchema,
  AgentHookSchema,
  HttpHookSchema,
])

export type HookCommand = z.infer<typeof HookCommandSchema>
export type BashCommandHook = Extract<HookCommand, { type: 'command' }>
export type PromptHook = Extract<HookCommand, { type: 'prompt' }>
export type AgentHook = Extract<HookCommand, { type: 'agent' }>
export type HttpHook = Extract<HookCommand, { type: 'http' }>
```

---

## Hook 来源

### 1. Settings 配置 (settings.json)

```typescript
// HookMatcher: 匹配器 + hooks 数组
export const HookMatcherSchema = z.object({
  matcher: z.string().optional(),  // 匹配模式 (如工具名 "Write")
  hooks: z.array(HookCommandSchema()),
})

// HooksSettings: 事件 → 匹配器数组
export const HooksSchema = z.partialRecord(
  z.enum(HOOK_EVENTS),
  z.array(HookMatcherSchema()),
)

export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>
```

### 2. SDK 注册回调

```typescript
export type HookCallback = {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseID: string | null,
    abort: AbortSignal | undefined,
    hookIndex?: number,
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean  // 内部 hooks 不计入 metrics
}

export type HookCallbackMatcher = {
  matcher?: string
  hooks: HookCallback[]
  pluginName?: string
}
```

### 3. Plugin Hooks

插件可以通过 `HookCallbackMatcher` 注册自己的 hooks，并通过 `pluginName` 标识来源。

---

## 配置格式

### settings.json 中的 hooks 配置

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'About to run bash command: $TOOL_INPUT'",
            "if": "Bash(git *)",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "eslint --fix $FILE_PATH",
            "timeout": 30,
            "statusMessage": "Running linter..."
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Session started'",
            "once": true
          }
        ]
      }
    ]
  }
}
```

### Prompt Hook 示例

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Review this bash command for safety: $ARGUMENTS",
            "model": "claude-sonnet-4-6"
          }
        ]
      }
    ]
  }
}
```

### HTTP Hook 示例

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "https://webhook.example.com/claude-code-events",
            "headers": {
              "Authorization": "Bearer $MY_WEBHOOK_TOKEN",
              "Content-Type": "application/json"
            },
            "allowedEnvVars": ["MY_WEBHOOK_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Agent Hook 示例

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "agent",
            "prompt": "Verify that the unit tests ran successfully and all passed. Check the output: $ARGUMENTS",
            "model": "claude-sonnet-4-6",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

### 条件过滤 (if) 示例

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Git operation detected'",
            "if": "Bash(git *)"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'TypeScript file being written'",
            "if": "Write(*.ts)"
          }
        ]
      }
    ]
  }
}
```

---

## 权限系统集成

### PreToolUse 权限决策

PreToolUse hook 可以直接控制工具执行权限:

```typescript
// hookSpecificOutput for PreToolUse:
{
  hookEventName: 'PreToolUse',
  // 权限决策: 'ask' | 'deny' | 'allow' | 'passthrough'
  permissionDecision: permissionBehaviorSchema().optional(),
  permissionDecisionReason: z.string().optional(),
  // 修改工具输入:
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  // 注入额外上下文:
  additionalContext: z.string().optional(),
}
```

### PermissionRequest Hook

当权限系统请求用户确认时，PermissionRequest hook 可以自动化决策:

```typescript
// hookSpecificOutput for PermissionRequest:
{
  hookEventName: 'PermissionRequest',
  decision: {
    behavior: 'allow',
    updatedInput: Record<string, unknown>,       // 修改后的输入
    updatedPermissions: PermissionUpdate[],      // 权限更新
  } | {
    behavior: 'deny',
    message: string,       // 拒绝原因
    interrupt: boolean,    // 是否中断
  }
}
```

### 权限更新类型

```typescript
type PermissionUpdate = {
  // 由 permissionUpdateSchema 定义
  // 可以动态更新权限规则
}
```

---

## Hook 生命周期

```
┌──────────────────────────────────────────────────────────────┐
│                    Hook 执行流程                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. 事件触发                                                 │
│     │                                                        │
│  2. 加载 Hook 配置                                           │
│     ├─ settings.json hooks                                   │
│     ├─ SDK registered callbacks (getRegisteredHooks)         │
│     └─ Plugin hooks                                          │
│     │                                                        │
│  3. 配置快照 (hooksConfigSnapshot.ts)                        │
│     ├─ shouldAllowManagedHooksOnly()                         │
│     └─ shouldDisableAllHooksIncludingManaged()               │
│     │                                                        │
│  4. Matcher 匹配                                             │
│     ├─ 无 matcher → 匹配所有                                 │
│     └─ 有 matcher → 字符串匹配 (如工具名)                    │
│     │                                                        │
│  5. If 条件过滤                                              │
│     └─ 权限规则语法: "Bash(git *)", "Read(*.ts)"            │
│     │                                                        │
│  6. 执行 Hook                                                │
│     ├─ command: spawn 子进程执行 shell 命令                  │
│     ├─ prompt: 调用 LLM 评估 prompt                         │
│     ├─ http: POST 请求到指定 URL                             │
│     ├─ agent: 启动 agent 执行验证                            │
│     └─ callback: 调用注册的回调函数                          │
│     │                                                        │
│  7. 解析输出 (hookJSONOutputSchema)                          │
│     ├─ 同步: 直接处理结果                                    │
│     └─ 异步: { async: true } → 后台运行                     │
│     │                                                        │
│  8. 聚合结果 (AggregatedHookResult)                          │
│     ├─ 合并所有 hook 的 additionalContext                    │
│     ├─ 处理 blockingErrors                                   │
│     └─ 确定最终 permissionBehavior                           │
│     │                                                        │
│  9. 应用结果                                                 │
│     ├─ preventContinuation → 停止执行                        │
│     ├─ permissionBehavior → 更新权限决策                     │
│     ├─ updatedInput → 修改工具输入                           │
│     └─ additionalContext → 注入上下文到消息                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 执行环境

Shell 命令 hook 的执行环境:

```typescript
// 子进程环境变量通过 subprocessEnv() 设置
// 包括:
// - 标准 PATH
// - Hook 特定环境变量
// - Plugin 选项 (通过 loadPluginOptions 注入)
// - Session 环境文件 (getHookEnvFilePath)

// Shell 选择:
// - bash (默认): 使用 $SHELL (bash/zsh/sh)
// - powershell: 使用 pwsh
import { DEFAULT_HOOK_SHELL } from './shell/shellProvider.js'
```

### 异步 Hook

```typescript
// async: true → 后台运行, 不阻塞主流程
// asyncRewake: true → 后台运行, exit code 2 时产生 blocking error

// 异步 hook 可以指定超时:
{
  async: true,
  asyncTimeout: 30  // 秒
}
```

### Once Hook

```typescript
// once: true → 执行一次后自动移除
// 适用于一次性初始化操作
```

---

## 类型定义详解

### HookCallbackContext

```typescript
/** Hook 回调的上下文，提供状态访问 */
export type HookCallbackContext = {
  getAppState: () => AppState
  updateAttributionState: (
    updater: (prev: AttributionState) => AttributionState,
  ) => void
}
```

### HookProgress

```typescript
export type HookProgress = {
  type: 'hook_progress'
  hookEvent: HookEvent
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}
```

### HookBlockingError

```typescript
export type HookBlockingError = {
  blockingError: string
  command: string
}
```

### HookResult (单个 Hook)

```typescript
export type HookResult = {
  message?: Message
  systemMessage?: Message
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}
```

### AggregatedHookResult (聚合结果)

```typescript
export type AggregatedHookResult = {
  message?: Message
  blockingErrors?: HookBlockingError[]
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}
```

### PermissionRequestResult

```typescript
export type PermissionRequestResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
    }
```

### Prompt Elicitation Protocol

```typescript
// Hook 可以向用户请求输入:
export const promptRequestSchema = z.object({
  prompt: z.string(),           // 请求 ID
  message: z.string(),          // 显示给用户的消息
  options: z.array(z.object({
    key: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })),
})

export type PromptResponse = {
  prompt_response: string       // 请求 ID
  selected: string              // 用户选择的 key
}
```

---

## Hook 配置管理

### hooksConfigSnapshot.ts

```typescript
// 从快照获取 hooks 配置:
export function getHooksConfigFromSnapshot(): HooksSettings

// 是否只允许托管 hooks:
export function shouldAllowManagedHooksOnly(): boolean

// 是否禁用所有 hooks (包括托管 hooks):
export function shouldDisableAllHooksIncludingManaged(): boolean
```

### hooksConfigManager.ts

```typescript
// Hook 配置管理器: 处理配置的加载、合并和验证
```

### hooksSettings.ts

```typescript
// Hook 设置的持久化和读取
```

---

## 遥测与监控

```typescript
// Hook 执行指标通过 analytics 记录:
logEvent('tengu_run_hook', {
  hook_event: hookEvent,
  hook_type: 'command' | 'prompt' | 'http' | 'agent' | 'callback',
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled',
  duration_ms: number,
  // ...
})

// OTel 事件记录:
logOTelEvent('hook_execution', { ... })

// Session tracing (beta):
startHookSpan() / endHookSpan()
```

### Hook 执行时间跟踪

```typescript
// 每轮 hook 执行时间累计:
addToTurnHookDuration(durationMs)
```
