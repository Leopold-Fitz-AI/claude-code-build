# Claude Code Agent 及多 Agent 工具

本文档描述 Agent 子代理工具、多 Agent 协调（swarm）工具、任务管理工具以及其他工作流工具。

---

## 1. AgentTool

**名称**: `Agent` (别名: `Task`) | **文件**: `src/tools/AgentTool/`

Agent 工具是 Claude Code 最核心的子代理系统，允许主 agent 派生子 agent 执行复杂任务。

### 核心常量

```typescript
// src/tools/AgentTool/constants.ts
export const AGENT_TOOL_NAME = 'Agent'
export const LEGACY_AGENT_TOOL_NAME = 'Task'  // 向后兼容

// 一次性内置 agent（不需要 SendMessage 继续通信）
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
```

### 输入参数

AgentTool 的输入通常包含以下字段：

| 参数 | 类型 | 说明 |
|------|------|------|
| `description` | string | agent 任务描述 |
| `prompt` | string | 发送给子 agent 的 prompt |
| `subagent_type` | string | agent 类型（匹配内置或自定义 agent） |
| `model` | string? | 模型覆盖 |
| `run_in_background` | boolean? | 是否后台运行 |
| `isolation` | 'worktree' \| 'remote'? | 隔离模式 |
| `mode` | string? | 权限模式 |

### 内置 Agent 定义

内置 agent 在 `src/tools/AgentTool/builtInAgents.ts` 中注册：

```typescript
function getBuiltInAgents(): AgentDefinition[] {
  const agents = [
    GENERAL_PURPOSE_AGENT,        // 通用子 agent
    STATUSLINE_SETUP_AGENT,       // 状态栏设置
  ]
  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT)    // 代码探索 agent
    agents.push(PLAN_AGENT)       // 计划 agent
  }
  agents.push(CLAUDE_CODE_GUIDE_AGENT)   // 使用指南 agent（非 SDK 入口）
  agents.push(VERIFICATION_AGENT)         // 验证 agent（feature flag 控制）
  return agents
}
```

#### 各内置 Agent 详情

| Agent | 文件 | 用途 |
|-------|------|------|
| `GENERAL_PURPOSE_AGENT` | `built-in/generalPurposeAgent.ts` | 通用子 agent，继承父工具集 |
| `EXPLORE_AGENT` | `built-in/exploreAgent.ts` | 代码库探索，只读操作 |
| `PLAN_AGENT` | `built-in/planAgent.ts` | 任务规划，生成执行计划 |
| `VERIFICATION_AGENT` | `built-in/verificationAgent.ts` | 验证执行结果正确性 |
| `CLAUDE_CODE_GUIDE_AGENT` | `built-in/claudeCodeGuideAgent.ts` | Claude Code 使用指南 |
| `STATUSLINE_SETUP_AGENT` | `built-in/statuslineSetup.ts` | 终端状态栏配置 |

### 自定义 Agent

用户可在以下目录创建自定义 agent：

- `~/.claude/agents/` — 全局自定义 agent
- `.claude/agents/` — 项目级自定义 agent

#### Agent 定义 Schema (`AgentJsonSchema`)

```typescript
z.object({
  description: z.string().min(1),           // agent 描述（必须）
  tools: z.array(z.string()).optional(),     // 允许使用的工具列表
  disallowedTools: z.array(z.string()).optional(), // 禁用的工具列表
  prompt: z.string().min(1),                // agent 系统 prompt（必须）
  model: z.string().optional(),             // 模型覆盖（"inherit" 继承父级）
  effort: z.union([                         // 推理努力程度
    z.enum(['low', 'medium', 'high']),
    z.number().int(),
  ]).optional(),
  permissionMode: z.enum([                  // 权限模式
    'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'
  ]).optional(),
  mcpServers: z.array(                      // MCP 服务器
    z.union([
      z.string(),                           // 按名称引用现有服务器
      z.record(z.string(), McpServerConfigSchema()),  // 内联定义
    ])
  ).optional(),
  hooks: HooksSchema().optional(),          // Hook 配置
  maxTurns: z.number().int().positive().optional(), // 最大对话轮数
  skills: z.array(z.string()).optional(),   // 可用技能
  initialPrompt: z.string().optional(),     // 初始 prompt
  memory: z.enum(['user', 'project', 'local']).optional(), // 记忆范围
  background: z.boolean().optional(),       // 默认后台运行
  isolation: z.enum(['worktree', 'remote']).optional(), // 隔离模式
})
```

### MCP 服务器规格

自定义 agent 可通过两种方式指定 MCP 服务器：

```typescript
type AgentMcpServerSpec =
  | string                          // 引用名称（如 "slack"）
  | { [name: string]: McpServerConfig }  // 内联定义
```

### Agent 记忆系统

Agent 记忆支持三种范围（`src/tools/AgentTool/agentMemory.ts`）：

```typescript
type AgentMemoryScope = 'user' | 'project' | 'local'
```

- `user`: 全局记忆（`~/.claude/` 下）
- `project`: 项目级记忆（`.claude/` 下）
- `local`: 本地记忆

记忆快照系统 (`agentMemorySnapshot.ts`) 用于跨会话持久化 agent 记忆状态。

### Agent 执行流程 (`runAgent.ts`)

1. 注册 agent ID → 设置 transcript 子目录
2. 加载 agent 定义 → 解析工具集和权限
3. 创建子 agent 上下文 (`createSubagentContext()`)
4. 执行子 agent hook (`executeSubagentStartHooks()`)
5. 调用 `query()` 开始子 agent 对话循环
6. 收集结果 → 清理资源

### Fork Subagent (`forkSubagent.ts`)

Fork subagent 共享父级的 prompt cache，避免重复构建系统 prompt：

```typescript
// 使用 renderedSystemPrompt 复用父级缓存
renderedSystemPrompt?: SystemPrompt
```

### Agent 配色管理

`agentColorManager.ts` 为每个 agent 分配独立颜色用于 UI 区分：

```typescript
const AGENT_COLORS: AgentColorName[] = [
  // 预定义的颜色列表
]
```

---

## 2. TeamCreateTool / TeamDeleteTool

**多 Agent Swarm 管理工具**

### TeamCreateTool

**名称**: `TeamCreate` | **文件**: `src/tools/TeamCreateTool/TeamCreateTool.ts`

创建多 agent 团队（swarm）。

```typescript
z.strictObject({
  team_name: z.string(),                    // 团队名称
  description: z.string().optional(),        // 团队描述/目的
  agent_type: z.string().optional(),         // 团队领导的类型/角色
})

type Output = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}
```

仅在 `isAgentSwarmsEnabled()` 返回 true 时可用。

### TeamDeleteTool

**名称**: `TeamDelete` | **文件**: `src/tools/TeamDeleteTool/TeamDeleteTool.ts`

删除已创建的 agent 团队。

---

## 3. SendMessageTool

**名称**: `SendMessage` | **文件**: `src/tools/SendMessageTool/SendMessageTool.ts`

在团队成员（teammate）之间发送消息。

### 输入参数

```typescript
z.object({
  to: z.string(),           // 收件人：teammate 名称、"*" 广播、"uds:<socket>" 或 "bridge:<session>"
  summary: z.string().optional(),  // 5-10 词预览摘要
  message: z.union([
    z.string(),             // 纯文本消息
    StructuredMessage,      // 结构化消息
  ]),
})
```

### 结构化消息类型

```typescript
const StructuredMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shutdown_request'),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('shutdown_response'),
    request_id: z.string(),
    approve: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan_approval_response'),
    request_id: z.string(),
    approve: z.boolean(),
    feedback: z.string().optional(),
  }),
])
```

### 消息投递机制

- **同进程 teammate**: 直接查找任务并入队消息
- **UDS (Unix Domain Socket)**: 本地对等通信
- **Bridge**: Remote Control 远程对等通信
- **Mailbox 系统**: `writeToMailbox()` 写入文件系统邮箱

---

## 4. Task 工具族

任务管理工具集（v2 版本），仅在 `isTodoV2Enabled()` 时可用。

### TaskCreateTool

**名称**: `TaskCreate` | **文件**: `src/tools/TaskCreateTool/TaskCreateTool.ts`

```typescript
z.strictObject({
  subject: z.string(),                         // 任务标题
  description: z.string(),                     // 任务描述
  activeForm: z.string().optional(),           // 进行中的动名词形式（如 "Running tests"）
  metadata: z.record(z.string(), z.unknown()).optional(), // 附加元数据
})

type Output = { task: { id: string; subject: string } }
```

### TaskUpdateTool

**名称**: `TaskUpdate` | **文件**: `src/tools/TaskUpdateTool/TaskUpdateTool.ts`

更新任务状态。支持的状态包括：`pending`、`in_progress`、`completed`、`cancelled`。

### TaskListTool

**名称**: `TaskList` | **文件**: `src/tools/TaskListTool/TaskListTool.ts`

列出当前会话中的所有任务。

### TaskGetTool

**名称**: `TaskGet` | **文件**: `src/tools/TaskGetTool/TaskGetTool.ts`

获取特定任务的详细信息。

### TaskStopTool

**名称**: `TaskStop` | **文件**: `src/tools/TaskStopTool/TaskStopTool.ts`

停止正在运行的后台任务。

### Task 工具共同特性

```typescript
isConcurrencySafe: true
shouldDefer: true
```

---

## 5. TodoWriteTool (v1 Legacy)

**名称**: `TodoWrite` | **文件**: `src/tools/TodoWriteTool/TodoWriteTool.ts`

v1 版本的待办事项工具，已被 Task 工具族（v2）替代。在 `isTodoV2Enabled()` 为 true 时，
由 Task 工具族取代。

---

## 6. Plan Mode 工具

### EnterPlanModeTool

**名称**: `EnterPlanMode` | **文件**: `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`

进入计划模式。计划模式下，agent 只能执行只读操作（搜索、阅读），不能进行写操作。

```typescript
// 进入计划模式时保存之前的权限模式
prePlanMode?: PermissionMode
```

### ExitPlanModeV2Tool

**名称**: `ExitPlanMode` | **文件**: `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`

退出计划模式，恢复之前的权限模式。

---

## 7. Worktree 工具

### EnterWorktreeTool

**名称**: `EnterWorktree` | **文件**: `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts`

进入 git worktree 隔离模式。在独立的 worktree 中执行操作，不影响主工作区。

### ExitWorktreeTool

**名称**: `ExitWorktree` | **文件**: `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts`

退出 worktree 隔离模式，返回主工作区。

### 启用条件

仅在 `isWorktreeModeEnabled()` 时可用。

---

## 8. AskUserQuestionTool

**名称**: `AskUserQuestion` | **文件**: `src/tools/AskUserQuestionTool/`

向用户提出问题，支持多选项和预览。

### 功能

- 向用户展示多选项问题
- 支持预览内容附加
- 仅在交互式上下文中可用
- `requiresUserInteraction()` 返回 `true`

---

## 9. Cron 工具族

定时任务调度系统，需要 `AGENT_TRIGGERS` feature flag。

### CronCreateTool

**名称**: `CronCreate` | **文件**: `src/tools/ScheduleCronTool/CronCreateTool.ts`

```typescript
z.strictObject({
  cron: z.string(),                  // 标准 5 字段 cron 表达式（本地时间）
  prompt: z.string(),                // 每次触发时执行的 prompt
  recurring: z.boolean().optional(), // true = 循环执行（默认），false = 单次
  durable: z.boolean().optional(),   // true = 持久化到 .claude/scheduled_tasks.json
})

type CreateOutput = {
  id: string
  humanSchedule: string
  recurring: boolean
  durable?: boolean
}
```

#### Cron 表达式格式

```
分 时 日 月 周
*/5 * * * *      → 每 5 分钟
30 14 28 2 *     → 每年 2 月 28 日 14:30
```

#### 持久化选项

| 模式 | 行为 |
|------|------|
| `durable: false` (默认) | 仅内存，会话结束后消失 |
| `durable: true` | 持久化到 `.claude/scheduled_tasks.json`，跨会话存活 |

### CronDeleteTool

**名称**: `CronDelete` | **文件**: `src/tools/ScheduleCronTool/CronDeleteTool.ts`

删除已创建的 cron 任务。

### CronListTool

**名称**: `CronList` | **文件**: `src/tools/ScheduleCronTool/CronListTool.ts`

列出所有活跃的 cron 任务。

### Cron 工具共同特性

```typescript
shouldDefer: true
maxResultSizeChars: 100_000
```

---

## 10. RemoteTriggerTool

**文件**: `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts`

远程 agent 触发工具，用于 CCR (Claude Code Remote) 场景。
需要 `AGENT_TRIGGERS_REMOTE` feature flag。

---

## 11. ToolSearchTool

**名称**: `ToolSearch` | **文件**: `src/tools/ToolSearchTool/ToolSearchTool.ts`

工具搜索入口，允许模型发现和加载延迟工具（deferred tools）。

当工具数量较多时，部分工具标记为 `shouldDefer: true`，仅在模型需要时通过 ToolSearch 加载。

---

## 12. TaskOutputTool

**名称**: `TaskOutput` | **文件**: `src/tools/TaskOutputTool/`

读取后台任务的输出结果。与 `BashTool` 的 `run_in_background` 配合使用。

---

## Agent 工具生态总览

```
              ┌──────────────┐
              │   AgentTool   │  ← 子 agent 派生
              └──────┬───────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
  ┌─────┴─────┐ ┌───┴───┐ ┌─────┴──────┐
  │ Built-in  │ │Custom │ │Coordinator │
  │  Agents   │ │Agents │ │  Workers   │
  └───────────┘ └───────┘ └────────────┘

  ┌──────────────────────────────────────┐
  │         Multi-Agent Swarm            │
  │                                      │
  │  TeamCreate ─→ SendMessage ←─ Teams  │
  │  TeamDelete     TaskCreate           │
  │                 TaskUpdate           │
  │                 TaskStop             │
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │         Workflow Control             │
  │                                      │
  │  EnterPlanMode / ExitPlanMode        │
  │  EnterWorktree / ExitWorktree        │
  │  AskUserQuestion                     │
  │  CronCreate / CronDelete / CronList  │
  └──────────────────────────────────────┘
```

---

## 相关文件路径

- AgentTool 主体: `/src/tools/AgentTool/`
  - `runAgent.ts` — Agent 执行核心
  - `builtInAgents.ts` — 内置 agent 注册
  - `loadAgentsDir.ts` — 自定义 agent 加载 + Schema
  - `agentMemory.ts` — 记忆系统
  - `forkSubagent.ts` — Fork 子 agent
  - `built-in/` — 各内置 agent 定义
- Team 工具: `/src/tools/TeamCreateTool/`, `/src/tools/TeamDeleteTool/`
- SendMessage: `/src/tools/SendMessageTool/`
- Task 工具: `/src/tools/TaskCreateTool/`, `TaskUpdateTool/`, `TaskListTool/`, `TaskGetTool/`, `TaskStopTool/`
- Plan Mode: `/src/tools/EnterPlanModeTool/`, `/src/tools/ExitPlanModeTool/`
- Worktree: `/src/tools/EnterWorktreeTool/`, `/src/tools/ExitWorktreeTool/`
- Cron: `/src/tools/ScheduleCronTool/`
- ToolSearch: `/src/tools/ToolSearchTool/`
